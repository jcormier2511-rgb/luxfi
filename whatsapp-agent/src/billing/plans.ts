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
  /** Active WTB+FS listings (combined) the account may have open at once — see
   *  maxActiveItemsFor below for how this applies to an account with no plan at all. */
  maxActiveItems: number;
}

export const MEMBERSHIP_PLANS: Record<PlanKey, PlanDef> = {
  tier1: { key: "tier1", label: "Tier 1", priceLabel: "$50/month", priceCents: 5000, weeklyLimit: 5, maxActiveItems: 3 },
  tier2: { key: "tier2", label: "Tier 2", priceLabel: "$150/month", priceCents: 15000, weeklyLimit: 20, maxActiveItems: 15 },
  tier3: { key: "tier3", label: "Tier 3", priceLabel: "$300/month", priceCents: 30000, weeklyLimit: null, maxActiveItems: 25 },
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

/**
 * The account's effective cap on active WTB+FS listings (combined), same posture as
 * weeklyLimitFor above except for the no-plan case: unlike approvals (which are meaningless
 * before someone even opens a listing, so they start at 0), an account still exploring Fi
 * before subscribing must be able to open a request at all — it gets Tier 1's cap (the lowest
 * paid tier) rather than 0, matching the "Basic account" cap already advertised to it in Fi's
 * own copy. `manualOverrideEnabled` is treated as unlimited, same as weeklyLimitFor.
 */
export function maxActiveItemsFor(entitlement: { plan: PlanKey | null; manualOverrideEnabled: boolean }): number | null {
  if (entitlement.manualOverrideEnabled) return null;
  if (!entitlement.plan) return MEMBERSHIP_PLANS.tier1.maxActiveItems;
  return MEMBERSHIP_PLANS[entitlement.plan].maxActiveItems;
}
