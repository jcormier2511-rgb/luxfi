import { withSchema, withTransaction } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { PostingRow } from "./postingsStore";
import { getEntitlement } from "../billing/entitlementStore";
import { sendText } from "../whapi/client";
import { config } from "../config";

async function getPhoneForCanonicalUser(canonicalUserId: number): Promise<string | null> {
  return withSchema(async (pool) => {
    const result = await pool.query(
      `SELECT identity FROM linked_identities WHERE canonical_user_id=$1 AND platform='whatsapp' LIMIT 1`,
      [canonicalUserId]
    );
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
function formatMatchMessage(matchId: number, self: PostingRow, counterpart: PostingRow, reasons: string[]): string {
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

  try {
    await sendText(phone, formatMatchMessage(matchId, self, counterpart, reasons));
  } catch (err) {
    console.error(`[postings] failed to deliver match notification ${matchId} to ${phone}:`, err);
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
  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
  return withSchema(async (pool) => {
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
  status: "approved" | "already_approved" | "locked" | "invalid";
  counterpart?: { name: string; phone: string };
}

/**
 * Fi Build Spec v4 §11.3 — atomic, idempotent approval transaction. Scoped exactly to what
 * was asked for: the first 3 account-level approvals are complimentary ($0 ledger entries);
 * the 4th and later are locked unless an admin has enabled account_entitlements.
 * manual_override_enabled (checked as a pre-transaction snapshot rather than inside this
 * transaction, since that table lives in a separate connection pool — see
 * src/billing/entitlementStore.ts — an acceptable trade-off since the override flag only
 * ever changes via a rare, deliberate admin action, not a money-safety-critical race). No
 * payment processor exists, so every ledger entry is $0 — a real charge is never attempted,
 * on either the complimentary or the locked-then-overridden path.
 */
export async function approveMatch(matchId: number, phone: string): Promise<ApprovalOutcome> {
  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
  const entitlement = await getEntitlement(phone);

  return withTransaction(async (client) => {
    const userResult = await client.query(`SELECT * FROM canonical_users WHERE id=$1 FOR UPDATE`, [canonicalUserId]);
    const user = userResult.rows[0];

    const recipientResult = await client.query(
      `SELECT * FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2 ORDER BY match_revision DESC LIMIT 1`,
      [matchId, canonicalUserId]
    );
    if (recipientResult.rows.length === 0) return { status: "invalid" };
    const recipient = recipientResult.rows[0];

    if (recipient.decision === "approved") {
      return { status: "already_approved", counterpart: await getCounterpartContact(client, matchId, canonicalUserId) };
    }

    const isComplimentary = user.total_approved_count < config.trial.maxApprovedMatches;
    if (!isComplimentary && !entitlement.manualOverrideEnabled) {
      return { status: "locked" };
    }

    // Idempotency key: match_id + approving_canonical_user_id. A duplicate/racing click hits
    // this conflict and is treated as an already-approved no-op rather than double-counting.
    const approvalInsert = await client.query(
      `INSERT INTO approvals (match_id, approving_canonical_user_id, is_complimentary) VALUES ($1,$2,$3)
       ON CONFLICT (match_id, approving_canonical_user_id) DO NOTHING RETURNING id`,
      [matchId, canonicalUserId, isComplimentary]
    );
    if (approvalInsert.rows.length === 0) {
      return { status: "already_approved", counterpart: await getCounterpartContact(client, matchId, canonicalUserId) };
    }

    await client.query(
      `INSERT INTO billing_ledger (canonical_user_id, match_id, amount_cents, currency, billing_status)
       VALUES ($1,$2,0,'USD',$3)`,
      [canonicalUserId, matchId, isComplimentary ? "complimentary" : "admin_override_pending_billing"]
    );

    await client.query(`UPDATE canonical_users SET total_approved_count = total_approved_count + 1 WHERE id=$1`, [
      canonicalUserId,
    ]);

    const matchRow = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
    const { fs_posting_id, wtb_posting_id } = matchRow.rows[0];
    const ownPostingId = await resolveOwnPostingId(client, fs_posting_id, wtb_posting_id, canonicalUserId);
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

    await client.query(`UPDATE match_recipients SET decision='approved', decided_at=now(), connected_at=now() WHERE id=$1`, [
      recipient.id,
    ]);

    return { status: "approved", counterpart: await getCounterpartContact(client, matchId, canonicalUserId) };
  });
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
): Promise<{ name: string; phone: string }> {
  const matchResult = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
  const { fs_posting_id, wtb_posting_id } = matchResult.rows[0] as unknown as { fs_posting_id: number; wtb_posting_id: number };
  const postings = await client.query(
    `SELECT id, canonical_user_id, contact_name, contact_phone FROM postings WHERE id = ANY($1::int[])`,
    [[fs_posting_id, wtb_posting_id]]
  );
  const mine = postings.rows.find((r) => r.canonical_user_id === approvingCanonicalUserId);
  const other = postings.rows.find((r) => r.id !== mine?.id) ?? postings.rows[0];
  return { name: other.contact_name, phone: other.contact_phone };
}
