import { withSchema } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
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
  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
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

/**
 * Records one approval against the canonical account: an idempotency-keyed insert into
 * `approvals` (ON CONFLICT DO NOTHING on match_id + approving_canonical_user_id — v4's
 * duplicate-click protection; a NULL match_id, always the case for v3, never conflicts with
 * anything, since v3 has its own state-machine-level idempotency instead — see flow.ts's
 * `pending.decisions[idx]` check), a $0 ledger entry (never a live charge — no payment
 * processor exists), and the canonical_users increment. Returns false only when a duplicate/
 * racing click on the same real match_id lost the ON CONFLICT race — the caller must not
 * apply any further side effects (posting counts, notifications) in that case.
 */
export async function recordApprovalEvent(
  client: QueryClient,
  canonicalUserId: number,
  matchId: number | null,
  isComplimentary: boolean
): Promise<boolean> {
  const insert = await client.query(
    `INSERT INTO approvals (match_id, approving_canonical_user_id, is_complimentary) VALUES ($1,$2,$3)
     ON CONFLICT (match_id, approving_canonical_user_id) DO NOTHING RETURNING id`,
    [matchId, canonicalUserId, isComplimentary]
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
 *  surrounding transaction — opens its own pool access via withSchema. */
export async function recordApprovalEventForPhone(canonicalUserId: number, isComplimentary: boolean): Promise<boolean> {
  return withSchema((pool) => recordApprovalEvent(pool, canonicalUserId, null, isComplimentary));
}
