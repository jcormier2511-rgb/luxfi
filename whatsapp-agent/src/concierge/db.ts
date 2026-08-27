import { Pool } from "pg";
import { config } from "../config";

/**
 * Fi Concierge expansion — its own Postgres schema, additive to (and reusing the same database
 * as) the existing v3 inventory_listings and v4 postings tables. Kept in its own module rather
 * than folded into postings/db.ts: the concierge subsystem (group registry, conversation
 * memory, reference requests, counterparty profiles) is a distinct, larger surface being built
 * in stages, and this keeps it from bloating the already-substantial v4 postings module it
 * builds on top of.
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
        -- Stage 1: Group Registry. Preserves compatibility with the existing
        -- V4_ALLOWED_CHAT_IDS env-var allowlist (config.postingsV4.allowedChatIds) — that
        -- static list keeps working unchanged; this table is the new, admin-manageable,
        -- per-group permission source the concierge expansion adds on top of it. A group
        -- doesn't have to be in this table to remain eligible via the legacy allowlist.
        CREATE TABLE IF NOT EXISTS designated_groups (
          chat_id TEXT PRIMARY KEY,
          group_name TEXT NOT NULL DEFAULT '',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          watchfacts_admin_managed BOOLEAN NOT NULL DEFAULT TRUE,
          allow_listing_monitoring BOOLEAN NOT NULL DEFAULT TRUE,
          allow_private_concierge BOOLEAN NOT NULL DEFAULT TRUE,
          -- Defaults OFF, unlike the other permissions above: posting into a group (even a
          -- deliberately anonymized reference request) is a more sensitive capability than
          -- read-only monitoring or a private 1:1 reply, so it requires its own explicit
          -- admin opt-in per group rather than inheriting "designated" status automatically.
          allow_reference_requests BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        `
      )
      .then(() => undefined);
  }
  await schemaReady;
}

export async function withSchema<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  await ensureSchema();
  return fn(getPool());
}

/** Explicit startup entry point, mirroring postings/db.ts's initSchema — safe to call unconditionally and repeatedly. */
export async function initConciergeSchema(): Promise<void> {
  await ensureSchema();
}

export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`DROP TABLE IF EXISTS designated_groups CASCADE`);
  schemaReady = null;
  await ensureSchema();
}

export async function _closePoolForTests(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}
