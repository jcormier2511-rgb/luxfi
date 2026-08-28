import { Pool, PoolClient } from 'pg';
import { ACCOUNT_COMPLIMENTARY_APPROVAL_LIMIT } from '../types/domain';

export const PER_APPROVAL_PRICE_USD = 2;
export const NON_MEMBER_MONTHLY_FEE_USD = 50;

export interface Entitlement {
  canonicalUserId: string;
  fiMembershipStatus: 'trial' | 'locked' | 'active' | 'waived_via_watchfacts';
  watchFactsMemberVerified: boolean;
  watchFactsVerificationSource: 'unverified' | 'manual_admin' | 'api_integration';
  paymentAuthorizationStatus: 'none' | 'pending_integration' | 'authorized';
  manualOverrideEnabled: boolean;
  manualOverrideBy: string | null;
  manualOverrideReason: string | null;
  manualOverrideAt: Date | null;
}

function rowToEntitlement(row: Record<string, unknown>): Entitlement {
  return {
    canonicalUserId: row.canonical_user_id as string,
    fiMembershipStatus: row.fi_membership_status as Entitlement['fiMembershipStatus'],
    watchFactsMemberVerified: row.watchfacts_member_verified as boolean,
    watchFactsVerificationSource: row.watchfacts_verification_source as Entitlement['watchFactsVerificationSource'],
    paymentAuthorizationStatus: row.payment_authorization_status as Entitlement['paymentAuthorizationStatus'],
    manualOverrideEnabled: row.manual_override_enabled as boolean,
    manualOverrideBy: (row.manual_override_by as string) ?? null,
    manualOverrideReason: (row.manual_override_reason as string) ?? null,
    manualOverrideAt: (row.manual_override_at as Date) ?? null,
  };
}

export async function ensureEntitlement(db: Pool | PoolClient, canonicalUserId: string): Promise<Entitlement> {
  const { rows } = await db.query(
    `INSERT INTO membership_entitlements (canonical_user_id)
     VALUES ($1)
     ON CONFLICT (canonical_user_id) DO UPDATE SET updated_at = membership_entitlements.updated_at
     RETURNING *`,
    [canonicalUserId]
  );
  return rowToEntitlement(rows[0]);
}

export type ApprovalGateDecision =
  | { allowed: true; isComplimentary: true }
  | { allowed: true; isComplimentary: false; ledgerStatus: 'pending_billing' }
  | { allowed: false; reason: 'locked_pending_admin_override' };

/**
 * Decides whether the NEXT approval by this account is allowed, and whether it
 * is complimentary or paid (spec sections 11.1-11.2, plus this session's MVP
 * instruction: lock approval #4+ unless an admin has manually enabled the
 * account; never attempt a live charge).
 */
export async function checkApprovalGate(db: Pool | PoolClient, canonicalUserId: string): Promise<ApprovalGateDecision> {
  const { rows } = await db.query(
    'SELECT trial_approvals_used FROM canonical_users WHERE id = $1 FOR UPDATE',
    [canonicalUserId]
  );
  const trialApprovalsUsed = rows[0]?.trial_approvals_used ?? 0;
  if (trialApprovalsUsed < ACCOUNT_COMPLIMENTARY_APPROVAL_LIMIT) {
    return { allowed: true, isComplimentary: true };
  }

  const entitlement = await ensureEntitlement(db, canonicalUserId);
  if (entitlement.manualOverrideEnabled) {
    return { allowed: true, isComplimentary: false, ledgerStatus: 'pending_billing' };
  }
  return { allowed: false, reason: 'locked_pending_admin_override' };
}

/**
 * Admin-only: manually enables or disables paid approvals for an account
 * without any payment processor being wired up (testing / early users).
 */
export async function setManualEntitlementOverride(
  pool: Pool,
  canonicalUserId: string,
  enabled: boolean,
  adminActor: string,
  reason?: string
): Promise<Entitlement> {
  await ensureEntitlement(pool, canonicalUserId);
  const { rows } = await pool.query(
    `UPDATE membership_entitlements SET
       manual_override_enabled = $2,
       manual_override_by = $3,
       manual_override_reason = $4,
       manual_override_at = now(),
       fi_membership_status = CASE WHEN $2 THEN 'active' ELSE 'locked' END,
       updated_at = now()
     WHERE canonical_user_id = $1
     RETURNING *`,
    [canonicalUserId, enabled, adminActor, reason ?? null]
  );
  return rowToEntitlement(rows[0]);
}

/**
 * Admin-only manual WatchFacts membership verification. Automatic verification
 * via the WatchFacts membership API is deferred for MVP (spec section 18 item 1
 * / this session's MVP instruction); this is the stand-in so the $50/month waiver
 * and cross-discount can still be exercised for known members.
 */
export async function setWatchFactsMembershipManual(
  pool: Pool,
  canonicalUserId: string,
  verified: boolean,
  adminActor: string
): Promise<Entitlement> {
  await ensureEntitlement(pool, canonicalUserId);
  const { rows } = await pool.query(
    `UPDATE membership_entitlements SET
       watchfacts_member_verified = $2,
       watchfacts_verification_source = 'manual_admin',
       fi_membership_status = CASE WHEN $2 THEN 'waived_via_watchfacts' ELSE fi_membership_status END,
       updated_at = now()
     WHERE canonical_user_id = $1
     RETURNING *`,
    [canonicalUserId, verified]
  );
  // eslint-disable-next-line no-console
  console.log(`[audit] ${adminActor} set watchfacts_member_verified=${verified} for user ${canonicalUserId}`);
  return rowToEntitlement(rows[0]);
}

export async function getEntitlement(pool: Pool, canonicalUserId: string): Promise<Entitlement> {
  return ensureEntitlement(pool, canonicalUserId);
}
