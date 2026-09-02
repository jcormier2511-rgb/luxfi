import { withSchema } from "../postings/db";
import { listAllEntitlements } from "../billing/entitlementStore";
import { getTopRequests, TopRequest } from "../postings/analytics";
import { config } from "../config";
import { ChannelPlatform } from "../channels/identity";

export interface MembershipCounts {
  totalUsers: number;
  paid: number;
  /** Still within the free-approval trial window, no plan assigned. */
  trial: number;
  /** Trial exhausted (used every complimentary approval), never upgraded to a plan. */
  nonPaying: number;
  /**
   * Approximated -- there is no live cancellation event anywhere in this app (see
   * billing/entitlementStore.ts: setPlan just overwrites the current row, no history is kept),
   * so this can't distinguish "never converted past trial" from "downgraded after paying."
   * Counted as: no active plan/override, but has approved at least one match (i.e. actually
   * got real value from Fi before going unpaid) -- a superset of `nonPaying` by design, not a
   * precise "these people canceled" figure.
   */
  canceledApprox: number;
}

export interface UserActivity {
  phone: string;
  searches: number;
  approvals: number;
  lastActiveAt: string | null;
  /** Null means no preference stated yet -- see postings/notificationPreferences.ts. */
  preferredChannel: ChannelPlatform | null;
  /** Every identity linked to this row's canonical user, phone included (see
   *  postings/notificationPreferences.ts's linkIdentity) -- today almost always just the one
   *  row's own phone, until an account actually links a second channel. */
  linkedIdentities: { platform: ChannelPlatform; identity: string }[];
}

export interface PaymentsSummary {
  yearToDateCents: number;
  currentMonthCents: number;
  currency: string;
}

export interface AdminMetrics {
  membership: MembershipCounts;
  topRequests: TopRequest[];
  activityByUser: UserActivity[];
  payments: PaymentsSummary;
}

interface UserRow {
  id: number;
  total_approved_count: number;
  phone: string;
}

async function getMembershipCounts(): Promise<MembershipCounts> {
  const [userRows, entitlements] = await Promise.all([
    withSchema((pool) =>
      // DISTINCT ON (cu.id), not a plain JOIN: a canonical user can now have more than one
      // linked identity (see postings/notificationPreferences.ts's linkIdentity) -- a plain
      // JOIN would return one row per identity and double-count that user here. Picks the
      // oldest linked identity as the representative phone, same ordering entitlements were
      // always looked up by before multi-identity linking existed.
      pool.query<UserRow>(
        `SELECT DISTINCT ON (cu.id) cu.id, cu.total_approved_count, li.identity AS phone
         FROM canonical_users cu
         JOIN linked_identities li ON li.canonical_user_id = cu.id
         ORDER BY cu.id, li.id`
      )
    ),
    listAllEntitlements(),
  ]);

  let paid = 0;
  let trial = 0;
  let nonPaying = 0;
  let canceledApprox = 0;
  for (const row of userRows.rows) {
    const entitlement = entitlements.get(row.phone);
    const isPaid = Boolean(entitlement && (entitlement.plan !== null || entitlement.manualOverrideEnabled));
    if (isPaid) {
      paid++;
      continue;
    }
    if (row.total_approved_count < config.trial.maxApprovedMatches) {
      trial++;
    } else {
      nonPaying++;
    }
    if (row.total_approved_count > 0) canceledApprox++;
  }

  return { totalUsers: userRows.rows.length, paid, trial, nonPaying, canceledApprox };
}

async function getActivityByUser(limit: number): Promise<UserActivity[]> {
  return withSchema(async (pool) => {
    const result = await pool.query<{
      phone: string; searches: string; approvals: string; last_active_at: string | null;
      preferred_channel: ChannelPlatform | null; linked_identities: { platform: ChannelPlatform; identity: string }[] | null;
    }>(
      `SELECT
         li.identity AS phone,
         COALESCE(sr.searches, 0) AS searches,
         COALESCE(ap.approvals, 0) AS approvals,
         GREATEST(sr.last_search_at, ap.last_approval_at) AS last_active_at,
         p.preferred_channel,
         (SELECT jsonb_agg(jsonb_build_object('platform', li2.platform, 'identity', li2.identity) ORDER BY li2.id)
          FROM linked_identities li2 WHERE li2.canonical_user_id = li.canonical_user_id) AS linked_identities
       FROM linked_identities li
       LEFT JOIN (
         SELECT phone, count(*) AS searches, max(created_at) AS last_search_at
         FROM search_requests GROUP BY phone
       ) sr ON sr.phone = li.identity
       LEFT JOIN (
         SELECT approving_canonical_user_id, count(*) AS approvals, max(created_at) AS last_approval_at
         FROM approvals GROUP BY approving_canonical_user_id
       ) ap ON ap.approving_canonical_user_id = li.canonical_user_id
       LEFT JOIN canonical_notification_preferences p ON p.canonical_user_id = li.canonical_user_id
       WHERE COALESCE(sr.searches, 0) > 0 OR COALESCE(ap.approvals, 0) > 0
       ORDER BY last_active_at DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((r) => ({
      phone: r.phone,
      searches: Number(r.searches),
      approvals: Number(r.approvals),
      lastActiveAt: r.last_active_at,
      preferredChannel: r.preferred_channel,
      linkedIdentities: r.linked_identities ?? [],
    }));
  });
}

/** Always $0 today -- no live payment processor is wired up anywhere in this app (see
 *  billing/entitlementStore.ts's module comment); billing_ledger.amount_cents is never
 *  anything but 0. Built now so this starts reflecting real revenue automatically the moment
 *  a real processor exists, with no dashboard rework needed then. */
async function getPaymentsSummary(): Promise<PaymentsSummary> {
  return withSchema(async (pool) => {
    const result = await pool.query<{ ytd_cents: string; mtd_cents: string }>(
      `SELECT
         COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('year', now())), 0) AS ytd_cents,
         COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS mtd_cents
       FROM billing_ledger`
    );
    return {
      yearToDateCents: Number(result.rows[0].ytd_cents),
      currentMonthCents: Number(result.rows[0].mtd_cents),
      currency: "USD",
    };
  });
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  const [membership, topRequests, activityByUser, payments] = await Promise.all([
    getMembershipCounts(),
    getTopRequests(10, 30),
    getActivityByUser(20),
    getPaymentsSummary(),
  ]);
  return { membership, topRequests, activityByUser, payments };
}
