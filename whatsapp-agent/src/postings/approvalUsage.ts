import { withSchema } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { platformForIdentity } from "../channels/identity";
import { getEntitlement, Entitlement } from "../billing/entitlementStore";
import { weeklyLimitFor, PlanKey } from "../billing/plans";
import { config } from "../config";

/**
 * Single source of truth for "has this canonical account got room for one more approval" —
 * used by BOTH the v3 on-demand search flow (conversation/flow.ts's handleDecision) and the
 * v4 automatic-matching flow (postings/notify.ts's approveMatch). Before this module existed,
 * each flow kept its own separate counter (v3: a per-phone JSON field; v4: canonical_users.
 * total_approved_count), so an account could exhaust its 3 complimentary approvals twice —
 * once through each system. Both now read and increment the SAME canonical_users row.
 */

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ApprovalUsageSnapshot {
  canonicalUserId: number;
  /** canonical_users.total_approved_count BEFORE this decision. */
  totalApproved: number;
  /** Whether the NEXT approval (if allowed) would be one of the 3 lifetime-complimentary ones. */
  isComplimentary: boolean;
  /** null = unlimited, 0 = no active plan, N = this plan's weekly cap. */
  weeklyLimit: number | null;
  /** Non-complimentary approvals in the last rolling 7 days — only meaningful when weeklyLimit is a number. */
  weeklyUsed: number;
  entitlement: Entitlement;
}

export type ApprovalGate =
  | { allowed: true; isComplimentary: boolean }
  | { allowed: false; reason: "no_plan" }
  | { allowed: false; reason: "weekly_cap"; plan: PlanKey; weeklyLimit: number };

/**
 * Approved-match introductions by this canonical user in the last rolling 7 days (not a
 * calendar week — avoids timezone-boundary ambiguity and needs no reset job). Only
 * non-complimentary approvals count; the 3 lifetime-free ones never touch a weekly cap.
 */
export async function getWeeklyApprovalCount(client: QueryClient, canonicalUserId: number): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM approvals
     WHERE approving_canonical_user_id=$1 AND is_complimentary=false AND created_at >= now() - interval '7 days'`,
    [canonicalUserId]
  );
  return result.rows[0].count as number;
}

/** Live snapshot of one phone's approval usage — the read side used for "status" display and
 *  by v3's flow.ts (which has no surrounding transaction of its own to reuse). */
export async function getApprovalUsage(phone: string): Promise<ApprovalUsageSnapshot> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const entitlement = await getEntitlement(phone);
  return withSchema(async (pool) => {
    const userResult = await pool.query(`SELECT total_approved_count FROM canonical_users WHERE id=$1`, [canonicalUserId]);
    const totalApproved = (userResult.rows[0]?.total_approved_count as number) ?? 0;
    const isComplimentary = totalApproved < config.trial.maxApprovedMatches;
    const weeklyLimit = weeklyLimitFor(entitlement);
    const weeklyUsed = !isComplimentary && weeklyLimit !== null ? await getWeeklyApprovalCount(pool, canonicalUserId) : 0;
    return { canonicalUserId, totalApproved, isComplimentary, weeklyLimit, weeklyUsed, entitlement };
  });
}

/** Pure decision from a snapshot — no I/O, so both callers can build one from data they
 *  already hold (v4's notify.ts already has `user`/`entitlement` inside its own transaction). */
export function evaluateApprovalGate(usage: ApprovalUsageSnapshot): ApprovalGate {
  if (usage.isComplimentary) return { allowed: true, isComplimentary: true };
  if (usage.weeklyLimit === null) return { allowed: true, isComplimentary: false }; // unlimited tier or legacy override
  if (usage.weeklyLimit === 0) return { allowed: false, reason: "no_plan" };
  if (usage.weeklyUsed >= usage.weeklyLimit) {
    return { allowed: false, reason: "weekly_cap", plan: usage.entitlement.plan as PlanKey, weeklyLimit: usage.weeklyLimit };
  }
  return { allowed: true, isComplimentary: false };
}

export interface CounterpartContact {
  name: string;
  phone: string;
}

/**
 * Records one approval against the canonical account: an idempotency-keyed insert into
 * `approvals` (ON CONFLICT DO NOTHING on match_id + approving_canonical_user_id — v4's
 * duplicate-click protection; a NULL match_id, always the case for v3, never conflicts with
 * anything, since v3 has its own state-machine-level idempotency instead — see flow.ts's
 * `pending.decisions[idx]` check), a $0 ledger entry (never a live charge — no payment
 * processor exists), and the canonical_users increment. Returns false only when a duplicate/
 * racing click on the same real match_id lost the ON CONFLICT race — the caller must not
 * apply any further side effects (posting counts, notifications) in that case.
 *
 * `counterpart` is the ONLY thing here that's ever premature to reveal: pass it now only when
 * this approval is ALREADY known-safe to reveal at record time (v3 — no mutual-confirmation
 * gate at all) or omit it (v4 — the mutual-confirmation dance may still be pending) and call
 * markApprovalRevealed once it's actually safe. `listingDescription` (just the watch, never a
 * person) is always safe to store immediately.
 */
export async function recordApprovalEvent(
  client: QueryClient,
  canonicalUserId: number,
  matchId: number | null,
  isComplimentary: boolean,
  listingDescription: string,
  counterpart?: CounterpartContact
): Promise<boolean> {
  const insert = await client.query(
    `INSERT INTO approvals (match_id, approving_canonical_user_id, is_complimentary, listing_description, counterpart_name, counterpart_phone)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (match_id, approving_canonical_user_id) DO NOTHING RETURNING id`,
    [matchId, canonicalUserId, isComplimentary, listingDescription, counterpart?.name ?? null, counterpart?.phone ?? null]
  );
  if (insert.rows.length === 0) return false;

  await client.query(
    `INSERT INTO billing_ledger (canonical_user_id, match_id, amount_cents, currency, billing_status)
     VALUES ($1,$2,0,'USD',$3)`,
    [canonicalUserId, matchId, isComplimentary ? "complimentary" : "plan_included"]
  );
  await client.query(`UPDATE canonical_users SET total_approved_count = total_approved_count + 1 WHERE id=$1`, [canonicalUserId]);
  return true;
}

/** Convenience wrapper for v3's on-demand flow, which has no real Postgres match row and no
 *  surrounding transaction — opens its own pool access via withSchema. v3 has no mutual-
 *  confirmation gate, so the counterpart is always already safe to store immediately. */
export async function recordApprovalEventForPhone(
  canonicalUserId: number,
  isComplimentary: boolean,
  listingDescription: string,
  counterpart: CounterpartContact
): Promise<boolean> {
  return withSchema((pool) => recordApprovalEvent(pool, canonicalUserId, null, isComplimentary, listingDescription, counterpart));
}

/**
 * Records a REAL membership charge (see billing/authorizeNet.ts + POST /webhook/authorizenet
 * in server.ts) — match_id NULL since this isn't tied to any one match. Every other
 * billing_ledger row (recordApprovalEvent above) is always amount_cents=0; this is the one
 * write path where a nonzero amount is ever expected, and is what makes the admin dashboard's
 * Payments card (admin/metrics.ts) show real revenue instead of always $0.
 */
export async function recordMembershipPayment(phone: string, amountCents: number, billingStatus: "membership_payment" | "membership_refund"): Promise<void> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  await withSchema((pool) =>
    pool.query(`INSERT INTO billing_ledger (canonical_user_id, match_id, amount_cents, currency, billing_status) VALUES ($1, NULL, $2, 'USD', $3)`, [
      canonicalUserId,
      amountCents,
      billingStatus,
    ])
  );
}

/**
 * Fills in the counterpart's contact info on an already-recorded approval, exactly when v4's
 * approveMatch determines it's actually safe to reveal (mutual confirmation complete, or no
 * counterpart WhatsApp identity to wait on) — the same moment the live "You're connected!"
 * reply/push itself fires. Until this runs, the row's counterpart fields stay NULL, so
 * getApprovedMatchesSummary can never surface a contact before the live reveal rules allow it.
 * A no-op (0 rows affected, no error) if the row doesn't exist yet or was already updated.
 */
export async function markApprovalRevealed(
  client: QueryClient,
  canonicalUserId: number,
  matchId: number,
  counterpart: CounterpartContact
): Promise<void> {
  await client.query(`UPDATE approvals SET counterpart_name=$1, counterpart_phone=$2 WHERE match_id=$3 AND approving_canonical_user_id=$4`, [
    counterpart.name,
    counterpart.phone,
    matchId,
    canonicalUserId,
  ]);
}

export interface ApprovedMatchSummary {
  listingDescription: string;
  /** null = approved, but not yet safe to reveal (still awaiting the other side's mutual confirmation). */
  counterpartName: string | null;
  counterpartPhone: string | null;
  approvedAt: string;
}

/** "My approved matches" — see conversation/flow.ts's "listings" command. Most recent first. */
export async function getApprovedMatchesSummary(phone: string, limit = 20): Promise<ApprovedMatchSummary[]> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  return withSchema(async (pool) => {
    const result = await pool.query(
      `SELECT listing_description, counterpart_name, counterpart_phone, created_at
       FROM approvals WHERE approving_canonical_user_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [canonicalUserId, limit]
    );
    return result.rows.map((r) => ({
      listingDescription: r.listing_description,
      counterpartName: r.counterpart_name,
      counterpartPhone: r.counterpart_phone,
      approvedAt: r.created_at,
    }));
  });
}
