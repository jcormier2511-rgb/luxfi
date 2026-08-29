import { Pool } from "pg";
import { config } from "../config";
import { PlanKey } from "./plans";

/**
 * Fi Build Spec v4 §11: after a canonical account's 3rd complimentary approval, further
 * approvals are locked until Fi billing is authorized. No payment processor exists yet
 * (spec §18 lists it as an explicitly deferred dependency), so the ONLY way to unlock
 * further approvals right now is an admin manually setting a plan (setPlan) or, for
 * backward compatibility, the older unlimited `manual_override_enabled` flag — never a live
 * charge, never self-service. `membershipVerified`/`paymentAuthorized`/`paymentStatus` are
 * placeholder columns: unused by any gating logic today, but present so wiring in real
 * WatchFacts membership verification or a payment processor later is an UPDATE to existing
 * rows, not another schema migration.
 *
 * `plan` replaces the earlier "$50/month + $2/approved match, unlimited once a member" model
 * with a flat-fee, weekly-capped tier (see billing/plans.ts) — NULL means no active plan.
 */

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.database.url });
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `
        CREATE TABLE IF NOT EXISTS account_entitlements (
          phone TEXT PRIMARY KEY,
          manual_override_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          membership_verified BOOLEAN,
          payment_authorized BOOLEAN,
          payment_status TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        ALTER TABLE account_entitlements ADD COLUMN IF NOT EXISTS plan TEXT;
        ALTER TABLE account_entitlements DROP CONSTRAINT IF EXISTS account_entitlements_plan_check;
        ALTER TABLE account_entitlements ADD CONSTRAINT account_entitlements_plan_check
          CHECK (plan IS NULL OR plan IN ('tier1', 'tier2', 'tier3'));
        `
      )
      .then(() => undefined);
  }
  await schemaReady;
}

export interface Entitlement {
  phone: string;
  manualOverrideEnabled: boolean;
  membershipVerified: boolean | null;
  paymentAuthorized: boolean | null;
  paymentStatus: string | null;
  plan: PlanKey | null;
}

interface EntitlementRow {
  phone: string;
  manual_override_enabled: boolean;
  membership_verified: boolean | null;
  payment_authorized: boolean | null;
  payment_status: string | null;
  plan: PlanKey | null;
}

function rowToEntitlement(row: EntitlementRow): Entitlement {
  return {
    phone: row.phone,
    manualOverrideEnabled: row.manual_override_enabled,
    membershipVerified: row.membership_verified,
    paymentAuthorized: row.payment_authorized,
    paymentStatus: row.payment_status,
    plan: row.plan,
  };
}

/** Creates a default (locked) row on first access — a phone with no row yet has never been granted anything. */
export async function getEntitlement(phone: string): Promise<Entitlement> {
  await ensureSchema();
  const result = await getPool().query(
    `INSERT INTO account_entitlements (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET phone = excluded.phone
     RETURNING *`,
    [phone]
  );
  return rowToEntitlement(result.rows[0] as EntitlementRow);
}

/** Admin-only action (see POST /admin/entitlement/override) — the sole way to unlock approvals past the trial. */
export async function setManualOverride(phone: string, enabled: boolean): Promise<Entitlement> {
  await ensureSchema();
  const result = await getPool().query(
    `INSERT INTO account_entitlements (phone, manual_override_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (phone) DO UPDATE SET manual_override_enabled = $2, updated_at = now()
     RETURNING *`,
    [phone, enabled]
  );
  return rowToEntitlement(result.rows[0] as EntitlementRow);
}

/** Admin-only action (see POST /admin/entitlement/plan) — the sole way to assign or clear a
 *  Fi membership tier. Never self-service, never a live charge (see module comment above). */
export async function setPlan(phone: string, plan: PlanKey | null): Promise<Entitlement> {
  await ensureSchema();
  const result = await getPool().query(
    `INSERT INTO account_entitlements (phone, plan, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (phone) DO UPDATE SET plan = $2, updated_at = now()
     RETURNING *`,
    [phone, plan]
  );
  return rowToEntitlement(result.rows[0] as EntitlementRow);
}

/**
 * Records that a user typed "join" post-trial — a signal for an admin to review, NOT a
 * self-service unlock (spec §11.2: "record a pending-billing state; do not silently provide
 * a paid connection"). Never sets manual_override_enabled.
 */
export async function recordBillingRequested(phone: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO account_entitlements (phone, payment_status, updated_at)
     VALUES ($1, 'requested', now())
     ON CONFLICT (phone) DO UPDATE SET payment_status = 'requested', updated_at = now()`,
    [phone]
  );
}

/** Test-only escape hatch, mirroring inventoryDb.ts's pattern. */
export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`DROP TABLE IF EXISTS account_entitlements`);
  schemaReady = null;
  await ensureSchema();
}

export async function _closePoolForTests(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}
