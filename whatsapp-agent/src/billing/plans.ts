/**
 * Fi membership pricing (replaces the earlier "$50/month + $2/approved match" model): a flat
 * monthly fee per tier, no per-approval charges, with the tier itself capping how many WTB/FS
 * introductions (approved matches) the account gets per rolling week. Still no live payment
 * processor — an admin assigns a phone's plan the same way account_entitlements.
 * manual_override_enabled was already assigned (see billing/entitlementStore.ts's setPlan),
 * never self-service and never a live charge.
 */
export type PlanKey = "tier1" | "tier2" | "tier3";

export interface PlanDef {
  key: PlanKey;
  label: string;
  priceLabel: string;
  /** Same amount as priceLabel, in cents — the numeric form billing/authorizeNet.ts charges
   *  and billing_ledger.amount_cents records, kept alongside the display string so the two can
   *  never drift out of sync. */
  priceCents: number;
  /** Approved-match introductions allowed per rolling 7-day window. null = unlimited. */
  weeklyLimit: number | null;
}

export const MEMBERSHIP_PLANS: Record<PlanKey, PlanDef> = {
  tier1: { key: "tier1", label: "Tier 1", priceLabel: "$50/month", priceCents: 5000, weeklyLimit: 5 },
  tier2: { key: "tier2", label: "Tier 2", priceLabel: "$150/month", priceCents: 15000, weeklyLimit: 20 },
  tier3: { key: "tier3", label: "Tier 3", priceLabel: "$300/month", priceCents: 30000, weeklyLimit: null },
};

export function isPlanKey(value: string): value is PlanKey {
  return value === "tier1" || value === "tier2" || value === "tier3";
}

/**
 * The account's effective weekly introduction cap: null = unlimited, 0 = no active plan
 * (locked), a number = that plan's weekly cap. `manualOverrideEnabled` is the pre-existing
 * admin escape hatch (previously "unlimited approvals once granted") — kept working exactly
 * as before for backward compatibility, treated as equivalent to the unlimited tier so an
 * account an admin already unlocked doesn't regress.
 */
export function weeklyLimitFor(entitlement: { plan: PlanKey | null; manualOverrideEnabled: boolean }): number | null {
  if (entitlement.manualOverrideEnabled) return null;
  if (!entitlement.plan) return 0;
  return MEMBERSHIP_PLANS[entitlement.plan].weeklyLimit;
}
