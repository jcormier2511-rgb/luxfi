import { withSchema, withTransaction } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { platformForIdentity } from "../channels/identity";
import { PostingRow, getPrimaryImageUrl } from "./postingsStore";
import { recordNotificationFailure } from "./status";
import { getEntitlement } from "../billing/entitlementStore";
import { weeklyLimitFor, PlanKey } from "../billing/plans";
import { getWeeklyApprovalCount, recordApprovalEvent, markApprovalRevealed } from "./approvalUsage";
import { sendText } from "../channels";
import { config } from "../config";
import { isPostingMonitoringEnabled } from "../admin/store";
import { markPendingEscrowOffer } from "../conversation/stateStore";

/**
 * Not filtered by platform: a canonical user has exactly one linked identity in this MVP
 * (see postings/identity.ts — no cross-platform merge UI yet), and that identity's own prefix
 * (see channels/identity.ts) is what tells sendText (channels/index.ts) which channel to use —
 * this lookup just needs to find it, whichever channel it's actually on.
 */
async function getPhoneForCanonicalUser(canonicalUserId: number): Promise<string | null> {
  return withSchema(async (pool) => {
    const result = await pool.query(`SELECT identity FROM linked_identities WHERE canonical_user_id=$1 LIMIT 1`, [canonicalUserId]);
    return result.rows[0]?.identity ?? null;
  });
}

async function getMatchWithPostings(
  matchId: number
): Promise<{ fs: PostingRow; wtb: PostingRow; reasons: string[] } | null> {
  return withSchema(async (pool) => {
    const matchResult = await pool.query(`SELECT * FROM matches WHERE id=$1`, [matchId]);
    if (matchResult.rows.length === 0) return null;
    const match = matchResult.rows[0];
    const postings = await pool.query<PostingRow>(`SELECT * FROM postings WHERE id = ANY($1::int[])`, [
      [match.fs_posting_id, match.wtb_posting_id],
    ]);
    const fs = postings.rows.find((p) => p.id === match.fs_posting_id);
    const wtb = postings.rows.find((p) => p.id === match.wtb_posting_id);
    if (!fs || !wtb) return null;
    return { fs, wtb, reasons: match.reasons ?? [] };
  });
}

function watchLabel(posting: PostingRow): string {
  if (posting.reference) return `${posting.brand || ""} ${posting.reference}`.trim();
  return posting.original_text.slice(0, 80);
}

/**
 * Spec §9.1's Potential Match format, minus the "Fi Intelligence" block (dealer
 * reputation/price trend/market range/authenticity) — no data source for any of that exists,
 * same honest omission the v3 flow's Match Card already makes. `matchId` is embedded in the
 * reply instructions since notifications are server-pushed, not part of a synchronous
 * request/response turn the way the v3 flow's numbered list is — the recipient needs a way
 * to say which match they mean.
 */
function formatMatchMessage(
  matchId: number,
  self: PostingRow,
  counterpart: PostingRow,
  reasons: string[],
  imageUrl: string | null
): string {
  const roleLabel = self.type === "FS" ? "Buyer" : "Seller";
  const priceLabel = counterpart.price !== null ? `$${counterpart.price}` : "price on ask";
  return (
    `Potential Match\n` +
    `${roleLabel}: ${counterpart.contact_name || "Unnamed"}\n` +
    `Type: ${counterpart.type}\n` +
    `Watch: ${watchLabel(counterpart)}\n` +
    `Asking/Bid: ${priceLabel}\n` +
    `Location: ${counterpart.location || "Not specified"}\n\n` +
    reasons.map((r) => `- ${r}`).join("\n") +
    (imageUrl ? `\n\nPhoto: ${imageUrl}` : "") +
    `\n\nReply "approve ${matchId}" to connect, or "pass ${matchId}" to skip.`
  );
}

/**
 * Notifies one canonical user about one match at one revision, idempotently: the INSERT ...
 * ON CONFLICT DO NOTHING on (match_id, recipient, revision) is the actual dedup — if it
 * returns no row, this exact notification already went out (a duplicate webhook delivery, a
 * re-run reconciliation sweep, etc.), so no second message is sent. The WhatsApp send itself
 * happens outside any DB transaction — a network call has no business holding a Postgres
 * transaction open.
 */
async function notifyOneRecipient(
  matchId: number,
  recipientCanonicalUserId: number,
  revision: number,
  self: PostingRow,
  counterpart: PostingRow,
  reasons: string[]
): Promise<void> {
  // Checked at send time, not just once at ingestion — a group removed from
  // V4_ALLOWED_CHAT_IDS (or the master flag turned off) after this posting was already stored
  // must stop it from generating notifications immediately. Checked BEFORE the claim below so
  // nothing gets marked "notified" for a message that was never actually sent — if the group
  // becomes allowed again later, this stays retryable rather than permanently skipped.
  if (!await isPostingMonitoringEnabled(self)) return;

  const claimed = await withSchema((pool) =>
    pool.query(
      `INSERT INTO match_recipients (match_id, recipient_canonical_user_id, match_revision, notified_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (match_id, recipient_canonical_user_id, match_revision) DO NOTHING
       RETURNING id`,
      [matchId, recipientCanonicalUserId, revision]
    )
  );
  if (claimed.rows.length === 0) return; // already notified — dedup

  const phone = await getPhoneForCanonicalUser(recipientCanonicalUserId);
  if (!phone) return; // e.g. the API-mirrored FS side has no WhatsApp identity to notify

  // Best-effort only — a listing with no captured image (most chat posts today, since
  // downloading/durable-storing WhatsApp media is still out of scope, see db.ts) just omits
  // the "Photo:" line, same honest omission pattern as the missing "Fi Intelligence" block.
  // Deliberately its own try/catch, separate from the sendText one below: an image lookup
  // failure (missing row, a transient DB hiccup) must fall back to a text-only match card,
  // never propagate out of here — this runs inside runImmediateMatch's per-candidate loop
  // (see matching.ts), so an uncaught throw here would silently abort matching against every
  // remaining candidate in that same sync/ingestion pass, not just skip one photo.
  let imageUrl: string | null = null;
  try {
    imageUrl = await getPrimaryImageUrl(counterpart.id);
  } catch (err) {
    console.error(`[postings] image lookup failed for posting ${counterpart.id} (falling back to text-only):`, err);
  }

  try {
    await sendText(phone, formatMatchMessage(matchId, self, counterpart, reasons, imageUrl));
  } catch (err) {
    console.error(`[postings] failed to deliver match notification ${matchId} to ${phone}:`, err);
    await recordNotificationFailure((err as Error).message);
  }
}

/** Notifies both sides of a match that have a canonical WhatsApp user (an API-sourced FS listing has none). */
export async function notifyMatch(matchId: number, revision: number): Promise<void> {
  const data = await getMatchWithPostings(matchId);
  if (!data) return;
  const { fs, wtb, reasons } = data;

  if (fs.canonical_user_id !== null) {
    await notifyOneRecipient(matchId, fs.canonical_user_id, revision, fs, wtb, reasons);
  }
  if (wtb.canonical_user_id !== null) {
    await notifyOneRecipient(matchId, wtb.canonical_user_id, revision, wtb, fs, reasons);
  }
}

export async function passMatch(matchId: number, phone: string): Promise<"passed" | "already_decided" | "invalid"> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  return withSchema(async (pool) => {
    const matchRow = await pool.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
    if (matchRow.rows.length === 0) return "invalid";
    const { fs_posting_id, wtb_posting_id } = matchRow.rows[0];
    // Checked at decision time, not just at ingestion — a posting from a group that's no
    // longer allowed must not accept a pass decision either.
    if (!(await isOwnPostingChatEnabled(pool, fs_posting_id, wtb_posting_id, canonicalUserId))) return "invalid";

    const recipientResult = await pool.query(
      `SELECT * FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2 ORDER BY match_revision DESC LIMIT 1`,
      [matchId, canonicalUserId]
    );
    if (recipientResult.rows.length === 0) return "invalid";
    const recipient = recipientResult.rows[0];
    if (recipient.decision !== "pending") return "already_decided";
    await pool.query(`UPDATE match_recipients SET decision='passed', decided_at=now() WHERE id=$1`, [recipient.id]);
    return "passed";
  });
}

export interface ApprovalOutcome {
  status: "approved" | "pending_confirmation" | "locked" | "invalid" | "posting_closed";
  counterpart?: { name: string; phone: string };
  /** Only set when status is "locked" — which of the two lock reasons this is, so the caller
   *  can show the right message (see server.ts's formatApprovalOutcome). */
  lockReason?: "no_plan" | "weekly_cap";
  plan?: PlanKey;
  weeklyLimit?: number;
}

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface MatchRecipientRow {
  id: number;
  decision: "pending" | "approved" | "passed";
  connected_at: string | null;
}

/**
 * Decision-time allowlist gate (spec: apply V4_ALLOWED_CHAT_IDS at approve/pass time, not
 * just at ingestion) — resolves whichever of the match's two postings belongs to the
 * requesting user and checks whether it's still chat-enabled. A posting that isn't
 * resolvable to either side (shouldn't happen for a real recipient) is never blocked on this
 * check alone.
 */
async function isOwnPostingChatEnabled(
  client: QueryClient,
  fsPostingId: number,
  wtbPostingId: number,
  canonicalUserId: number
): Promise<boolean> {
  const result = await client.query(`SELECT canonical_user_id, source_type, source_chat_id FROM postings WHERE id = ANY($1::int[])`, [
    [fsPostingId, wtbPostingId],
  ]);
  const mine = result.rows.find((r) => r.canonical_user_id === canonicalUserId);
  if (!mine) return true;
  return isPostingMonitoringEnabled(mine);
}

/** `lock` uses FOR UPDATE — only ever set true for the CALLER's own row, never the counterpart's, to avoid two concurrent approvals on the same match deadlocking on each other's rows. */
async function getRecipientRow(
  client: QueryClient,
  matchId: number,
  canonicalUserId: number,
  lock: boolean
): Promise<MatchRecipientRow | null> {
  const result = await client.query(
    `SELECT * FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2
     ORDER BY match_revision DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [matchId, canonicalUserId]
  );
  return result.rows[0] ?? null;
}

/**
 * Fi Build Spec v4 §9/§11 — atomic, idempotent approval transaction that ends in an actual
 * introduction, not just a recorded click, while never revealing either party's contact info
 * to someone who hasn't themselves confirmed:
 *
 * - When the counterpart is a real WhatsApp user, BOTH sides must independently approve
 *   before EITHER learns the other's contact info. The first approver gets
 *   "pending_confirmation" (nothing revealed). The second approver's own approval reveals to
 *   them synchronously (returned here) AND pushes a one-time introduction back to the first
 *   approver, who was left waiting — see the sendText call after the transaction below.
 * - When the counterpart has no WhatsApp identity (an API-mirrored WatchFacts listing),
 *   there's no one to wait on, so a single approval reveals immediately.
 * - matches.connected_at is the match-level "connected" record; match_recipients.connected_at
 *   is the per-side idempotency claim — a duplicate click, a second approval from the same
 *   side, or the counterpart's own later approval can never re-trigger a send once a side's
 *   connected_at is set.
 * - A posting that already hit its 5-approved-match cap (status != 'active') refuses any
 *   further approval outright, even against a match that was created/surfaced before it
 *   closed.
 *
 * The first 3 account-level approvals are complimentary ($0 ledger entries). After that, this
 * shares the SAME gating logic v3's on-demand flow uses (postings/approvalUsage.ts) — no plan
 * assigned locks further approvals outright; a tier1/tier2 plan allows up to its weekly cap
 * (rolling 7 days); tier3 or the legacy admin override (account_entitlements.manual_override_
 * enabled) is unlimited. No payment processor exists, so every ledger entry is $0 — a real
 * charge is never attempted; an admin assigns the plan (see src/billing/entitlementStore.ts).
 */
export async function approveMatch(matchId: number, phone: string): Promise<ApprovalOutcome> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const entitlement = await getEntitlement(phone);

  const result = await withTransaction(async (client) => {
    const matchRow = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
    if (matchRow.rows.length === 0) return { outcome: { status: "invalid" as const }, notify: null };
    const { fs_posting_id, wtb_posting_id } = matchRow.rows[0];

    // Checked at decision time, not just at ingestion — a posting from a group that's no
    // longer allowed (or with the master flag now off) must not accept an approve decision.
    if (!(await isOwnPostingChatEnabled(client, fs_posting_id, wtb_posting_id, canonicalUserId))) {
      return { outcome: { status: "invalid" as const }, notify: null };
    }

    const userResult = await client.query(`SELECT * FROM canonical_users WHERE id=$1 FOR UPDATE`, [canonicalUserId]);
    const user = userResult.rows[0];

    const recipient = await getRecipientRow(client, matchId, canonicalUserId, true);
    if (!recipient) return { outcome: { status: "invalid" as const }, notify: null };

    const ownPostingId = await resolveOwnPostingId(client, fs_posting_id, wtb_posting_id, canonicalUserId);

    if (recipient.decision !== "approved") {
      // The closed-posting guard only applies to a genuinely NEW approval — re-clicking
      // "approve" on a match this side already approved before the posting closed must still
      // work idempotently (same info, no new count), since it isn't a 6th approval at all.
      if (ownPostingId !== null) {
        const ownPosting = await client.query(`SELECT status FROM postings WHERE id=$1 FOR UPDATE`, [ownPostingId]);
        if (ownPosting.rows[0]?.status !== "active") {
          return { outcome: { status: "posting_closed" as const }, notify: null };
        }
      }

      const isComplimentary = user.total_approved_count < config.trial.maxApprovedMatches;
      if (!isComplimentary) {
        const weeklyLimit = weeklyLimitFor(entitlement);
        if (weeklyLimit === 0) {
          return { outcome: { status: "locked" as const, lockReason: "no_plan" as const }, notify: null };
        }
        if (weeklyLimit !== null) {
          const weeklyUsed = await getWeeklyApprovalCount(client, canonicalUserId);
          if (weeklyUsed >= weeklyLimit) {
            return {
              outcome: { status: "locked" as const, lockReason: "weekly_cap" as const, plan: entitlement.plan as PlanKey, weeklyLimit },
              notify: null,
            };
          }
        }
      }

      // Idempotency key: match_id + approving_canonical_user_id. A duplicate/racing click hits
      // this conflict and is treated as a no-op rather than double-counting. No counterpart
      // passed here — mutual confirmation may still be pending; markApprovalRevealed below
      // fills it in the moment it's actually safe to.
      const fsPostingForDescription = await client.query(`SELECT * FROM postings WHERE id=$1`, [fs_posting_id]);
      const listingDescription = watchLabel(fsPostingForDescription.rows[0]);
      const approved = await recordApprovalEvent(client, canonicalUserId, matchId, isComplimentary, listingDescription);
      if (approved) {
        if (ownPostingId !== null) {
          const updated = await client.query(
            `UPDATE postings SET approved_match_count = approved_match_count + 1, updated_at=now()
             WHERE id=$1 RETURNING approved_match_count`,
            [ownPostingId]
          );
          if (updated.rows[0].approved_match_count >= 5) {
            await client.query(`UPDATE postings SET status='completed_match_limit' WHERE id=$1`, [ownPostingId]);
          }
        }

        await client.query(`UPDATE match_recipients SET decision='approved', decided_at=now() WHERE id=$1`, [recipient.id]);
      }
      // else: lost a race to a concurrent duplicate click on the same match+user — fall
      // through and re-derive current state below, with no double side effects.
    }

    const counterpart = await getCounterpartContact(client, matchId, canonicalUserId);
    const counterpartRecipient =
      counterpart.canonicalUserId !== null ? await getRecipientRow(client, matchId, counterpart.canonicalUserId, false) : null;
    const counterpartReady = counterpart.canonicalUserId === null || counterpartRecipient?.decision === "approved";

    if (!counterpartReady) {
      return { outcome: { status: "pending_confirmation" as const }, notify: null };
    }

    // Mutual condition met (or no counterpart confirmation was ever needed) — reveal to me
    // now. Both UPDATEs are idempotency claims (WHERE ... IS NULL): harmless no-ops on a
    // duplicate click or the counterpart's own later approval.
    await client.query(`UPDATE match_recipients SET connected_at = now() WHERE id=$1 AND connected_at IS NULL`, [recipient.id]);
    await client.query(`UPDATE matches SET connected_at = now() WHERE id=$1 AND connected_at IS NULL`, [matchId]);
    // Exactly the moment my own "my approved matches" summary (approvalUsage.ts) becomes
    // allowed to show this counterpart — never before.
    await markApprovalRevealed(client, canonicalUserId, matchId, { name: counterpart.name, phone: counterpart.phone });

    let notify: { canonicalUserId: number; myContact: { name: string; phone: string } } | null = null;
    if (counterpartRecipient && !counterpartRecipient.connected_at) {
      // I'm the second (mutual-completing) approver — the counterpart was left on
      // "pending_confirmation" and never got revealed; tell them now, exactly once.
      // Checked at (push) notification time, before claiming — the counterpart's own
      // posting's group must still be allowed, even though it was allowed when the
      // match/notification was originally created. Checking before the claim (rather than
      // after) leaves this retryable rather than permanently consumed if their group is
      // later re-allowed.
      const counterpartStillEnabled = await isOwnPostingChatEnabled(client, fs_posting_id, wtb_posting_id, counterpart.canonicalUserId!);
      if (counterpartStillEnabled) {
        const claimCounterpart = await client.query(
          `UPDATE match_recipients SET connected_at = now() WHERE id=$1 AND connected_at IS NULL RETURNING id`,
          [counterpartRecipient.id]
        );
        if (claimCounterpart.rows.length > 0) {
          const myContact = await getCounterpartContact(client, matchId, counterpart.canonicalUserId!);
          notify = { canonicalUserId: counterpart.canonicalUserId!, myContact: { name: myContact.name, phone: myContact.phone } };
          // The counterpart's own approvals row (inserted when THEY first approved and got
          // left on "pending_confirmation") only now becomes safe to reveal too.
          await markApprovalRevealed(client, counterpart.canonicalUserId!, matchId, { name: myContact.name, phone: myContact.phone });
        }
      }
    }

    return {
      outcome: { status: "approved" as const, counterpart: { name: counterpart.name, phone: counterpart.phone } },
      notify,
    };
  });

  if (result.notify) {
    const phone = await getPhoneForCanonicalUser(result.notify.canonicalUserId);
    if (phone) {
      try {
        await sendText(
          phone,
          `You're connected! ${result.notify.myContact.name}: ${result.notify.myContact.phone}\n\n${config.fiFlow.escrowSuggestion}`
        );
        markPendingEscrowOffer(phone);
      } catch (err) {
        console.error(`[postings] failed to deliver connection introduction for match ${matchId} to ${phone}:`, err);
        await recordNotificationFailure((err as Error).message);
      }
    }
  }

  return result.outcome;
}

async function resolveOwnPostingId(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { id: number; canonical_user_id: number | null }[] }> },
  fsPostingId: number,
  wtbPostingId: number,
  canonicalUserId: number
): Promise<number | null> {
  const result = await client.query(`SELECT id, canonical_user_id FROM postings WHERE id = ANY($1::int[])`, [
    [fsPostingId, wtbPostingId],
  ]);
  const mine = result.rows.find((r) => r.canonical_user_id === canonicalUserId);
  return mine ? mine.id : null;
}

async function getCounterpartContact(
  client: {
    query: (
      sql: string,
      params: unknown[]
    ) => Promise<{ rows: { id: number; canonical_user_id: number | null; contact_name: string; contact_phone: string }[] }>;
  },
  matchId: number,
  approvingCanonicalUserId: number
): Promise<{ name: string; phone: string; canonicalUserId: number | null }> {
  const matchResult = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
  const { fs_posting_id, wtb_posting_id } = matchResult.rows[0] as unknown as { fs_posting_id: number; wtb_posting_id: number };
  const postings = await client.query(
    `SELECT id, canonical_user_id, contact_name, contact_phone FROM postings WHERE id = ANY($1::int[])`,
    [[fs_posting_id, wtb_posting_id]]
  );
  const mine = postings.rows.find((r) => r.canonical_user_id === approvingCanonicalUserId);
  const other = postings.rows.find((r) => r.id !== mine?.id) ?? postings.rows[0];
  return { name: other.contact_name, phone: other.contact_phone, canonicalUserId: other.canonical_user_id };
}
