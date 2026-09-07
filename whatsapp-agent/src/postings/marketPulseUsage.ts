import { withSchema } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { platformForIdentity } from "../channels/identity";
import { getEntitlement } from "../billing/entitlementStore";
import { config } from "../config";

/**
 * Market Pulse (price/trend look-ups — conversation/flow.ts's MARKET_COMMAND/
 * MARKET_OVERVIEW_COMMAND/parseMarketReferenceCommand handling) is metered completely
 * separately from approved-match introductions (postings/approvalUsage.ts): a pulse is a
 * read-only lookup, never an introduction, so it must never draw down or share that counter.
 * Same trial-then-membership shape (3 free, then a weekly cap), but the weekly cap is a flat
 * number for ANY active membership tier rather than scaling with plan — Market Pulse doesn't
 * need tier-scaled room the way introductions do. Adjustable later once real usage data exists.
 */

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface MarketPulseUsageSnapshot {
  canonicalUserId: number;
  /** canonical_users.total_market_pulse_count BEFORE this look-up. */
  totalLookups: number;
  /** Whether the NEXT look-up (if allowed) would be one of the free trial ones. */
  isComplimentary: boolean;
  /** null = unlimited (admin override), 0 = no active plan, N = the flat weekly cap for members. */
  weeklyLimit: number | null;
  /** Non-complimentary look-ups in the last rolling 7 days — only meaningful when weeklyLimit is a number. */
  weeklyUsed: number;
}

export type MarketPulseGate =
  | { allowed: true; isComplimentary: boolean }
  | { allowed: false; reason: "no_plan" }
  | { allowed: false; reason: "weekly_cap"; weeklyLimit: number };

/** Same rolling-7-day convention as approvalUsage.ts's getWeeklyApprovalCount — avoids
 *  timezone-boundary ambiguity and needs no reset job. */
export async function getWeeklyMarketPulseCount(client: QueryClient, canonicalUserId: number): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM market_pulse_lookups
     WHERE canonical_user_id=$1 AND is_complimentary=false AND created_at >= now() - interval '7 days'`,
    [canonicalUserId]
  );
  return result.rows[0].count as number;
}

export async function getMarketPulseUsage(phone: string): Promise<MarketPulseUsageSnapshot> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const entitlement = await getEntitlement(phone);
  return withSchema(async (pool) => {
    const userResult = await pool.query(`SELECT total_market_pulse_count FROM canonical_users WHERE id=$1`, [canonicalUserId]);
    const totalLookups = (userResult.rows[0]?.total_market_pulse_count as number) ?? 0;
    const isComplimentary = totalLookups < config.trial.maxMarketPulseLookups;
    const weeklyLimit = entitlement.manualOverrideEnabled ? null : entitlement.plan ? config.marketPulse.weeklyLimit : 0;
    const weeklyUsed = !isComplimentary && weeklyLimit !== null ? await getWeeklyMarketPulseCount(pool, canonicalUserId) : 0;
    return { canonicalUserId, totalLookups, isComplimentary, weeklyLimit, weeklyUsed };
  });
}

/** Pure decision from a snapshot — mirrors evaluateApprovalGate's shape/no-I/O convention. */
export function evaluateMarketPulseGate(usage: MarketPulseUsageSnapshot): MarketPulseGate {
  if (usage.isComplimentary) return { allowed: true, isComplimentary: true };
  if (usage.weeklyLimit === null) return { allowed: true, isComplimentary: false };
  if (usage.weeklyLimit === 0) return { allowed: false, reason: "no_plan" };
  if (usage.weeklyUsed >= usage.weeklyLimit) return { allowed: false, reason: "weekly_cap", weeklyLimit: usage.weeklyLimit };
  return { allowed: true, isComplimentary: false };
}

/** Records one look-up against the canonical account. Called only after evaluateMarketPulseGate
 *  already allowed it — never itself makes the gating decision. */
export async function recordMarketPulseLookup(canonicalUserId: number, isComplimentary: boolean): Promise<void> {
  return withSchema(async (pool) => {
    await pool.query(`INSERT INTO market_pulse_lookups (canonical_user_id, is_complimentary) VALUES ($1,$2)`, [canonicalUserId, isComplimentary]);
    await pool.query(`UPDATE canonical_users SET total_market_pulse_count = total_market_pulse_count + 1 WHERE id=$1`, [canonicalUserId]);
  });
}

/**
 * Advises the user of their usage every time, not only once they've hit the cap (real reported
 * ask: "make sure we advise the user of the usage limits") — appended to every allowed Market
 * Pulse reply. Reflects the look-up that was JUST recorded, so the count already includes it.
 */
export function formatMarketPulseUsageNote(usage: MarketPulseUsageSnapshot, gate: MarketPulseGate): string {
  if (!gate.allowed) return "";
  if (gate.isComplimentary) {
    const remaining = Math.max(0, config.trial.maxMarketPulseLookups - (usage.totalLookups + 1));
    return `\n\n(Market Pulse: ${remaining} of ${config.trial.maxMarketPulseLookups} free look-ups left in your trial.)`;
  }
  if (usage.weeklyLimit === null) return "";
  return `\n\n(Market Pulse: ${usage.weeklyUsed + 1} of ${usage.weeklyLimit} used this week.)`;
}
