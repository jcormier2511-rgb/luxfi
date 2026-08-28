/**
 * Payment-processor interface, intentionally not wired to a real processor in
 * this MVP release. The schema (billing_ledger, membership_entitlements) and
 * this interface are preserved so a real integration can be dropped in later
 * without touching the approval/entitlement logic that calls it.
 *
 * MVP behavior: entitlement.service.ts never calls chargeApproval/chargeMembership
 * for a live charge. The only implementation available is NullPaymentProcessor,
 * which always reports the charge as `pending_integration` and never returns
 * `charged`. Approvals that require billing are still recorded in
 * billing_ledger with status='pending_billing' so the ledger and any future
 * reconciliation job have a real, auditable record once billing goes live.
 */
export interface ChargeResult {
  status: 'charged' | 'pending_integration';
  processorChargeId?: string;
}

export interface PaymentProcessor {
  chargeApproval(params: { canonicalUserId: string; amountUsd: number }): Promise<ChargeResult>;
  chargeMembershipFee(params: { canonicalUserId: string; amountUsd: number }): Promise<ChargeResult>;
}

export class NullPaymentProcessor implements PaymentProcessor {
  async chargeApproval(): Promise<ChargeResult> {
    return { status: 'pending_integration' };
  }

  async chargeMembershipFee(): Promise<ChargeResult> {
    return { status: 'pending_integration' };
  }
}

let processor: PaymentProcessor | undefined;

export function getPaymentProcessor(): PaymentProcessor {
  if (!processor) {
    processor = new NullPaymentProcessor();
  }
  return processor;
}
