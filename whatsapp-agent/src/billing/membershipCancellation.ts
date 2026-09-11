import { getEntitlement, cancelMembership } from "./entitlementStore";
import { cancelArbSubscription } from "./authorizeNet";

export interface SelfServiceCancellationResult {
  /** Whether there was an active paid plan to cancel at all. */
  hadActivePlan: boolean;
  /** True when Authorize.net's own cancel call failed -- the entitlement is still cleared (see
   *  below), but the underlying subscription may keep billing until cancelled by hand. */
  arbCancelFailed: boolean;
}

/**
 * Self-service membership cancellation -- triggered by a user's own "fire Fi"/"cancel my
 * membership" command (conversation/flow.ts) or by STOP (server.ts's opt-out handling). This is
 * the mirror image of cancelMembership's own usual caller (POST /webhook/authorizenet), which
 * only ever REACTS to a cancellation Authorize.net already made. Here WE are the one telling
 * Authorize.net to stop billing, so the ARB call has to actually run.
 *
 * The entitlement is cleared regardless of whether the ARB cancel call succeeds -- a failed ARB
 * call must never leave someone still locked into a membership they explicitly asked to leave;
 * it only means the underlying subscription needs a manual follow-up (visible via
 * arbCancelFailed, logged loudly below) rather than the user being made to wait or retry. A
 * manual-override member (no authnetSubscriptionId at all -- comped, or an admin-assigned plan
 * outside the real payment flow) has nothing to tell Authorize.net, so the ARB call is skipped
 * entirely rather than attempted against a subscription id that was never real.
 */
export async function cancelOwnMembership(phone: string): Promise<SelfServiceCancellationResult> {
  const entitlement = await getEntitlement(phone);
  const hadActivePlan = entitlement.plan !== null;
  let arbCancelFailed = false;
  if (entitlement.authnetSubscriptionId) {
    try {
      await cancelArbSubscription(entitlement.authnetSubscriptionId);
    } catch (err) {
      arbCancelFailed = true;
      console.error(
        `[billing] ARB cancel FAILED for phone=${phone} subscriptionId=${entitlement.authnetSubscriptionId} -- ` +
          `entitlement is being cleared anyway, but Authorize.net may still be billing this subscription until it is cancelled by hand:`,
        err
      );
    }
  }
  await cancelMembership(phone);
  return { hadActivePlan, arbCancelFailed };
}
