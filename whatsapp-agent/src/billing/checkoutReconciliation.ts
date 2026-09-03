import {
  CheckoutSession,
  activateMembership,
  claimCheckoutSessionForActivation,
  clearSupersededSubscription,
  findStalePendingCheckouts,
  getEntitlement,
  markCheckoutSessionStatus,
  releaseCheckoutSessionClaim,
} from "./entitlementStore";
import {
  cancelArbSubscription,
  createArbSubscription,
  createProfileTransaction,
  getCustomerPaymentProfileIds,
  isAuthorizeNetConfigured,
} from "./authorizeNet";
import { recordMembershipPayment } from "../postings/approvalUsage";
import { sendText } from "../channels";

/**
 * Turning a saved card into an active membership — the single implementation both activators
 * share.
 *
 * A membership used to be activatable exactly one way: Authorize.net's
 * net.authorize.customer.paymentProfile.created webhook. When that webhook never arrived — not
 * registered, wrong signature key, or simply not delivered — the customer's card was saved,
 * nothing charged it, and the account stayed inactive with no trace of the attempt anywhere. The
 * reconciliation sweep below is the recovery path, and it MUST do exactly what the webhook does,
 * so both call this rather than keeping two copies in step by hand.
 *
 * The caller must already hold the session's claim (claimCheckoutSessionForActivation), which is
 * what makes a double charge impossible when a delayed webhook and a sweep arrive together.
 */
export async function activateClaimedCheckout(
  session: CheckoutSession,
  customerProfileId: string,
  customerPaymentProfileId: string,
  source: "webhook" | "reconciliation"
): Promise<"activated" | "declined"> {
  const charge = await createProfileTransaction({ plan: session.plan, customerProfileId, customerPaymentProfileId });
  if (charge.responseCode !== "1") {
    console.warn(
      `[billing/${source}] month-1 charge (transId=${charge.transId}) declined (responseCode=${charge.responseCode}) -- marking checkout session ${session.id} failed`
    );
    await markCheckoutSessionStatus(session.id, "failed", charge.transId);
    await sendText(
      session.phone,
      'Your card was declined when I tried to charge it — reply "join" to try again with a different card.'
    ).catch(() => undefined);
    return "declined";
  }
  const subscriptionId = await createArbSubscription({ plan: session.plan, customerProfileId, customerPaymentProfileId });
  const entitlement = await activateMembership(session.phone, session.plan, { customerProfileId, paymentProfileId: customerPaymentProfileId, subscriptionId });
  await recordMembershipPayment(session.phone, charge.settleAmountCents, "membership_payment");
  await markCheckoutSessionStatus(session.id, "completed", charge.transId);
  console.log(`[billing/${source}] activated ${session.plan} for phone=${session.phone} (subscriptionId=${subscriptionId})`);
  await retireSupersededSubscription(session.phone, entitlement.supersededSubscriptionId, source);
  return "activated";
}

/**
 * Stop the recurring charge an upgrade replaced.
 *
 * Changing tier creates a NEW ARB subscription; the previous one keeps billing at
 * Authorize.net until something cancels it. Nothing did — so a member moving from tier1 to
 * tier2 paid $50 AND $150 every month, indefinitely, and the id needed to stop it was
 * overwritten at the same moment (see superseded_subscription_id in entitlementStore).
 *
 * Deliberately runs AFTER the new membership is active, and never throws:
 *  - cancel succeeds -> the flag clears and billing is correct.
 *  - cancel fails    -> the customer keeps the access they just paid for, the id stays on the
 *                       row, and the failure is logged loudly. That is exactly today's
 *                       behavior, except now it is recorded and recoverable instead of lost.
 * Doing it in the other order would risk cancelling someone's billing and then failing to
 * activate what they paid for, which is the one outcome worse than double billing.
 */
async function retireSupersededSubscription(phone: string, supersededSubscriptionId: string | null, source: string): Promise<void> {
  if (!supersededSubscriptionId) return;
  try {
    await cancelArbSubscription(supersededSubscriptionId);
    await clearSupersededSubscription(phone);
    console.log(`[billing/${source}] cancelled superseded subscription ${supersededSubscriptionId} for phone=${phone}`);
  } catch (err) {
    console.error(
      `[billing/${source}] FAILED to cancel superseded subscription ${supersededSubscriptionId} for phone=${phone} — ` +
        `this account is being billed TWICE until it is cancelled by hand. It stays on ` +
        `account_entitlements.superseded_subscription_id (see findUncancelledSupersededSubscriptions):`,
      err
    );
  }
}

export interface CheckoutReconciliationResult {
  scanned: number;
  activated: number;
  declined: number;
  /** Checkouts whose hosted page was opened but where no card was ever saved — nothing to do. */
  noCardSaved: number;
  /** Already active by the time the sweep looked (a webhook won the race) — resolved, not charged. */
  alreadyActive: number;
  skipped: number;
  error?: string;
}

/**
 * Recovers checkouts whose activation webhook never arrived.
 *
 * Mirrors the existing v4 match reconciliation (postings/matching.ts + POST /admin/reconciliation):
 * a periodic safety net for exactly the failures that, by their nature, cannot announce
 * themselves. Every step is guarded so a sweep can never charge twice:
 *
 *  - only checkouts older than `minAgeMinutes` are considered, so a webhook still in flight wins
 *    normally and the sweep never races it;
 *  - the session's claim must be won before anything is charged;
 *  - an account that already carries an active plan resolves its session without a charge;
 *  - a profile with no saved card releases its claim and stays pending for a later sweep, since
 *    the customer may still be part-way through the hosted page.
 */
export async function runCheckoutReconciliation(options: { minAgeMinutes?: number; limit?: number } = {}): Promise<CheckoutReconciliationResult> {
  const result: CheckoutReconciliationResult = { scanned: 0, activated: 0, declined: 0, noCardSaved: 0, alreadyActive: 0, skipped: 0 };
  if (!isAuthorizeNetConfigured()) return { ...result, error: "Authorize.net is not configured" };

  const minAgeMinutes = options.minAgeMinutes ?? Number(process.env.CHECKOUT_RECONCILIATION_MIN_AGE_MINUTES ?? 10);
  const limit = options.limit ?? 25;

  let stale: CheckoutSession[];
  try {
    stale = await findStalePendingCheckouts(minAgeMinutes, limit);
  } catch (err) {
    return { ...result, error: (err as Error).message };
  }
  result.scanned = stale.length;

  for (const candidate of stale) {
    try {
      const session = await claimCheckoutSessionForActivation(candidate.id);
      if (!session) { result.skipped += 1; continue; }
      const customerProfileId = session.authnetCustomerProfileId;
      if (!customerProfileId) { result.skipped += 1; continue; }

      // A membership that is already active means the webhook landed after this session was
      // listed. Resolve the session so it stops being swept; never charge a second time.
      const entitlement = await getEntitlement(session.phone);
      if (entitlement.plan && !entitlement.canceledAt) {
        await markCheckoutSessionStatus(session.id, "completed");
        result.alreadyActive += 1;
        continue;
      }

      const paymentProfileIds = await getCustomerPaymentProfileIds(customerProfileId);
      if (paymentProfileIds.length === 0) {
        await releaseCheckoutSessionClaim(session.id);
        result.noCardSaved += 1;
        continue;
      }

      const outcome = await activateClaimedCheckout(session, customerProfileId, paymentProfileIds[paymentProfileIds.length - 1], "reconciliation");
      if (outcome === "activated") {
        result.activated += 1;
        // The join reply promised the membership would unlock automatically. It just did, later
        // than intended and without anything the customer can see having happened — so say so.
        await sendText(
          session.phone,
          "Your Fi membership is now active — thanks for your patience, your payment went through."
        ).catch(() => undefined);
      } else {
        result.declined += 1;
      }
    } catch (err) {
      console.error(`[billing/reconciliation] checkout ${candidate.id} failed:`, (err as Error).message);
      await releaseCheckoutSessionClaim(candidate.id).catch(() => undefined);
      result.skipped += 1;
    }
  }
  return result;
}
