import { Pool } from "pg";
import crypto from "crypto";
import { config } from "../config";
import { PlanKey } from "./plans";

/**
 * Fi Build Spec v4 §11: after a canonical account's 3rd complimentary approval, further
 * approvals are locked until Fi billing is authorized. Two ways to unlock: the real one is a
 * completed Authorize.net charge (see billing/authorizeNet.ts + POST /webhook/authorizenet in
 * server.ts), which calls activateMembership below automatically; setPlan and the older
 * unlimited `manual_override_enabled` flag remain as the admin-only manual fallback for
 * accounts handled outside that flow (comps, disputes, migrating an existing member).
 * `membershipVerified` stays an unused placeholder column (no real WatchFacts membership
 * verification exists yet); `paymentAuthorized`/`paymentStatus` are now live, set by
 * activateMembership/cancelMembership from real payment events.
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

        -- Authorize.net CIM/ARB identifiers for the account's real recurring subscription (see
        -- billing/authorizeNet.ts) -- set once the /webhook/authorizenet handler confirms a
        -- successful first charge, cleared on cancellation. canceled_at is the real "this
        -- account used to pay and no longer does" signal the admin dashboard's canceledApprox
        -- metric (admin/metrics.ts) is a stand-in for until every existing paying account has
        -- gone through this real payment flow at least once.
        ALTER TABLE account_entitlements ADD COLUMN IF NOT EXISTS authnet_customer_profile_id TEXT;
        ALTER TABLE account_entitlements ADD COLUMN IF NOT EXISTS authnet_payment_profile_id TEXT;
        ALTER TABLE account_entitlements ADD COLUMN IF NOT EXISTS authnet_subscription_id TEXT;
        ALTER TABLE account_entitlements ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;

        -- One row per "Fi sent a payment link" attempt (see billing/checkoutStore.ts). Expires
        -- unused after a day (checkoutStore.ts's own responsibility, not this schema) -- kept
        -- indefinitely otherwise as the audit trail for what was ever charged and why.
        CREATE TABLE IF NOT EXISTS checkout_sessions (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          plan TEXT NOT NULL CHECK (plan IN ('tier1', 'tier2', 'tier3')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
          authnet_trans_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at TIMESTAMPTZ
        );

        -- The CIM profile created for this specific checkout attempt (see billing/
        -- authorizeNet.ts's createCustomerProfile) -- set as soon as GET /pay/:id creates or
        -- recovers it, so the later net.authorize.customer.paymentProfile.created webhook (which
        -- only carries Authorize.net's own customerProfileId, nothing of ours) can be traced
        -- back to this session via findCheckoutSessionByProfileId.
        ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS authnet_customer_profile_id TEXT;

        -- Set by whichever activator (the webhook, or the reconciliation sweep that covers a
        -- webhook that never arrived) has taken responsibility for turning this checkout into a
        -- membership. Two activators charging the same saved card is the one failure this whole
        -- mechanism must not have, and a read-then-check on status cannot prevent it -- both
        -- would read "pending". Claiming is a single conditional UPDATE, so exactly one wins.
        ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
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
  authnetCustomerProfileId: string | null;
  authnetPaymentProfileId: string | null;
  authnetSubscriptionId: string | null;
  canceledAt: string | null;
}

interface EntitlementRow {
  phone: string;
  manual_override_enabled: boolean;
  membership_verified: boolean | null;
  payment_authorized: boolean | null;
  payment_status: string | null;
  plan: PlanKey | null;
  authnet_customer_profile_id: string | null;
  authnet_payment_profile_id: string | null;
  authnet_subscription_id: string | null;
  canceled_at: string | null;
}

function rowToEntitlement(row: EntitlementRow): Entitlement {
  return {
    phone: row.phone,
    manualOverrideEnabled: row.manual_override_enabled,
    membershipVerified: row.membership_verified,
    paymentAuthorized: row.payment_authorized,
    paymentStatus: row.payment_status,
    plan: row.plan,
    authnetCustomerProfileId: row.authnet_customer_profile_id,
    authnetPaymentProfileId: row.authnet_payment_profile_id,
    authnetSubscriptionId: row.authnet_subscription_id,
    canceledAt: row.canceled_at,
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
    `INSERT INTO account_entitlements (phone, plan, payment_authorized, payment_status, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (phone) DO UPDATE SET plan = $2, payment_authorized = $3, payment_status = $4, updated_at = now()
     RETURNING *`,
    [phone, plan, plan !== null, plan === null ? "inactive" : "active"]
  );
  return rowToEntitlement(result.rows[0] as EntitlementRow);
}

/**
 * The real, automatic counterpart to setPlan/setManualOverride above — called only from
 * POST /webhook/authorizenet once Authorize.net confirms a successful first charge (see
 * billing/authorizeNet.ts). Stores the CIM/ARB identifiers needed to bill month 2 onward and
 * to cancel later, and clears any prior canceled_at (a returning member re-subscribing is no
 * longer canceled).
 */
export async function activateMembership(
  phone: string,
  plan: PlanKey,
  authnet: { customerProfileId: string; paymentProfileId: string; subscriptionId: string }
): Promise<Entitlement> {
  await ensureSchema();
  const result = await getPool().query(
    `INSERT INTO account_entitlements
       (phone, plan, payment_authorized, payment_status, authnet_customer_profile_id, authnet_payment_profile_id, authnet_subscription_id, canceled_at, updated_at)
     VALUES ($1, $2, TRUE, 'active', $3, $4, $5, NULL, now())
     ON CONFLICT (phone) DO UPDATE SET
       plan = $2, payment_authorized = TRUE, payment_status = 'active',
       authnet_customer_profile_id = $3, authnet_payment_profile_id = $4, authnet_subscription_id = $5,
       canceled_at = NULL, updated_at = now()
     RETURNING *`,
    [phone, plan, authnet.customerProfileId, authnet.paymentProfileId, authnet.subscriptionId]
  );
  return rowToEntitlement(result.rows[0] as EntitlementRow);
}

/**
 * Looks up which phone an Authorize.net ARB subscriptionId belongs to — needed by
 * POST /webhook/authorizenet's subscription-suspended/cancelled/terminated handling, which
 * only carries the subscriptionId, not the phone.
 */
export async function findPhoneByAuthnetSubscriptionId(subscriptionId: string): Promise<string | null> {
  await ensureSchema();
  const result = await getPool().query(`SELECT phone FROM account_entitlements WHERE authnet_subscription_id = $1`, [subscriptionId]);
  return result.rows.length > 0 ? (result.rows[0].phone as string) : null;
}

/**
 * Called from POST /webhook/authorizenet on a subscription-suspended/cancelled/terminated
 * event — the real "canceled" signal, replacing the admin dashboard's canceledApprox
 * heuristic (admin/metrics.ts) for any account that has gone through this real payment flow.
 * Leaves authnet_subscription_id in place as a record of what was canceled.
 */
export async function cancelMembership(phone: string): Promise<Entitlement> {
  await ensureSchema();
  const result = await getPool().query(
    `INSERT INTO account_entitlements (phone, plan, payment_authorized, payment_status, canceled_at, updated_at)
     VALUES ($1, NULL, FALSE, 'canceled', now(), now())
     ON CONFLICT (phone) DO UPDATE SET plan = NULL, payment_authorized = FALSE, payment_status = 'canceled', canceled_at = now(), updated_at = now()
     RETURNING *`,
    [phone]
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

/**
 * Bulk, read-only fetch for the admin dashboard's membership metrics (see admin/metrics.ts) --
 * a phone with no row is implicitly "no plan, no override" (getEntitlement's own default), so
 * callers should treat a missing map entry the same as that default rather than needing every
 * phone to have a row first. Deliberately does NOT use getEntitlement's insert-on-read
 * behavior, which would otherwise litter account_entitlements with a row for every canonical
 * user just from viewing the dashboard.
 */
export async function listAllEntitlements(): Promise<Map<string, Entitlement>> {
  await ensureSchema();
  const result = await getPool().query(`SELECT * FROM account_entitlements`);
  const map = new Map<string, Entitlement>();
  for (const row of result.rows as EntitlementRow[]) {
    map.set(row.phone, rowToEntitlement(row));
  }
  return map;
}

export interface CheckoutSession {
  id: string;
  phone: string;
  plan: PlanKey;
  status: "pending" | "completed" | "failed";
  authnetTransId: string | null;
  authnetCustomerProfileId: string | null;
}

function rowToCheckoutSession(row: {
  id: string;
  phone: string;
  plan: PlanKey;
  status: string;
  authnet_trans_id: string | null;
  authnet_customer_profile_id: string | null;
}): CheckoutSession {
  return {
    id: row.id,
    phone: row.phone,
    plan: row.plan,
    status: row.status as CheckoutSession["status"],
    authnetTransId: row.authnet_trans_id,
    authnetCustomerProfileId: row.authnet_customer_profile_id,
  };
}

/**
 * Created when a user replies "join"/"upgrade" (see conversation/flow.ts) and Authorize.net is
 * configured — the id is what GET /pay/:id and the eventual webhook correlate back to a
 * phone+plan, so it's opaque and unguessable (20 random hex chars, 80 bits of entropy) rather
 * than a short/sequential value someone could enumerate to trigger another phone's checkout
 * page. Exactly 20 chars, not a full 36-char UUID, because this id doubles as Authorize.net's
 * merchantCustomerId when creating a CIM profile (see billing/authorizeNet.ts's
 * createCustomerProfile), which has a hard 20-character limit; a longer id would need lossy
 * truncation with a (tiny but real) collision risk.
 */
export async function createCheckoutSession(phone: string, plan: PlanKey): Promise<CheckoutSession> {
  await ensureSchema();
  const id = crypto.randomBytes(10).toString("hex");
  const result = await getPool().query(`INSERT INTO checkout_sessions (id, phone, plan) VALUES ($1, $2, $3) RETURNING *`, [id, phone, plan]);
  return rowToCheckoutSession(result.rows[0]);
}

export async function getCheckoutSession(id: string): Promise<CheckoutSession | null> {
  await ensureSchema();
  const result = await getPool().query(`SELECT * FROM checkout_sessions WHERE id = $1`, [id]);
  return result.rows.length > 0 ? rowToCheckoutSession(result.rows[0]) : null;
}

/** Set once GET /pay/:id creates or recovers the CIM profile for this checkout attempt. */
export async function setCheckoutSessionProfileId(id: string, customerProfileId: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE checkout_sessions SET authnet_customer_profile_id = $2 WHERE id = $1`, [id, customerProfileId]);
}

/**
 * The ONLY way to trace a net.authorize.customer.paymentProfile.created webhook back to a
 * phone+plan -- that event carries Authorize.net's own customerProfileId, nothing of ours.
 */
export async function findCheckoutSessionByProfileId(customerProfileId: string): Promise<CheckoutSession | null> {
  await ensureSchema();
  const result = await getPool().query(`SELECT * FROM checkout_sessions WHERE authnet_customer_profile_id = $1`, [customerProfileId]);
  return result.rows.length > 0 ? rowToCheckoutSession(result.rows[0]) : null;
}

/**
 * The most recent checkout attempt for a phone, whatever became of it.
 *
 * Activation happens only when Authorize.net's paymentProfile.created webhook arrives (see
 * server.ts's handleAuthorizeNetWebhookEvent), so a checkout that was started and then never
 * confirmed leaves no trace on the entitlement record at all — the account just looks like one
 * that never tried to join. Reading the attempt itself is what lets Fi tell those two apart.
 */
export async function findLatestCheckoutAttempt(
  phone: string
): Promise<{ id: string; plan: PlanKey; status: CheckoutSession["status"]; createdAt: string } | null> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT id, plan, status, created_at FROM checkout_sessions WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const row = result.rows[0];
  return row ? { id: row.id, plan: row.plan, status: row.status, createdAt: new Date(row.created_at).toISOString() } : null;
}

/**
 * Atomically take ownership of a still-pending checkout so exactly one activator can charge it.
 *
 * Returns the session on success, or null when another activator already holds it (or it is no
 * longer pending). The stale-claim window lets a claim that died mid-flight — a process
 * restart between the claim and the charge — be retried later rather than stranding the
 * checkout forever; it is deliberately longer than a charge could plausibly take.
 */
export async function claimCheckoutSessionForActivation(
  id: string,
  staleClaimMinutes = 15
): Promise<CheckoutSession | null> {
  await ensureSchema();
  const result = await getPool().query(
    `UPDATE checkout_sessions SET claimed_at = now()
     WHERE id = $1 AND status = 'pending'
       AND (claimed_at IS NULL OR claimed_at < now() - ($2 || ' minutes')::interval)
     RETURNING *`,
    [id, String(staleClaimMinutes)]
  );
  return result.rows.length > 0 ? rowToCheckoutSession(result.rows[0]) : null;
}

/** Releases a claim taken by claimCheckoutSessionForActivation without resolving the checkout —
 *  used when the card turns out not to be saved yet, so a later sweep can pick it up again. */
export async function releaseCheckoutSessionClaim(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE checkout_sessions SET claimed_at = NULL WHERE id = $1 AND status = 'pending'`, [id]);
}

/**
 * Checkouts that have been pending long enough that their webhook is not simply in flight, and
 * that have a CIM profile to ask Authorize.net about. `minAgeMinutes` keeps the sweep from
 * racing a webhook that is arriving normally.
 */
export async function findStalePendingCheckouts(minAgeMinutes: number, limit: number): Promise<CheckoutSession[]> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM checkout_sessions
     WHERE status = 'pending' AND authnet_customer_profile_id IS NOT NULL
       AND created_at < now() - ($1 || ' minutes')::interval
     ORDER BY created_at ASC LIMIT $2`,
    [String(minAgeMinutes), limit]
  );
  return result.rows.map(rowToCheckoutSession);
}

export async function markCheckoutSessionStatus(id: string, status: "completed" | "failed", authnetTransId?: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE checkout_sessions SET status = $2, authnet_trans_id = coalesce($3, authnet_trans_id), completed_at = now() WHERE id = $1`,
    [id, status, authnetTransId ?? null]
  );
}

/** Test-only escape hatch, mirroring inventoryDb.ts's pattern. */
/** Test-only: run one query against this module's pool (used to backdate checkout rows). */
export async function _withPoolForTests<T>(fn: (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> {
  await ensureSchema();
  return fn(getPool());
}

export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`DROP TABLE IF EXISTS checkout_sessions`);
  await getPool().query(`DROP TABLE IF EXISTS account_entitlements`);
  schemaReady = null;
  await ensureSchema();
}

export async function _closePoolForTests(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}
