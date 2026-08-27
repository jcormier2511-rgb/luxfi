import { Pool, PoolClient } from "pg";
import { config } from "../config";

/**
 * Fi Build Spec v4 — automatic matching/monitoring system. Additive to the existing (working,
 * deployed) `inventory_listings` table and v3 on-demand conversation flow, per the spec's own
 * "do not discard existing work" instruction: `inventory_listings` keeps serving the v3
 * search-on-demand flow unchanged, while this module is the new automatic-monitoring/matching
 * path the v4 spec describes. API FS listings are mirrored into `postings` (see
 * mirrorApiFsPosting, called from syncInventory.ts) so matching has one unified live source
 * without risking a rewrite of the already-tested sync pipeline.
 *
 * Design simplifications vs. the full spec (documented, not hidden):
 * - "Monitor" is not a separate table — an active posting (status='active' AND
 *   expires_at > now()) IS the monitor. Its own status/expires_at/approved_match_count fields
 *   carry the lifecycle the spec describes for monitors.
 * - "Introduction" is a field on match_recipients (connected_at), not a separate table.
 * - account_entitlements (phone-keyed, already built/deployed) is reused as-is rather than
 *   migrated to canonical_user_id — phone and canonical_user are 1:1 in this MVP (no
 *   cross-platform identity merging UI exists), so this is a safe simplification for now.
 * - Image handling stores source_url only; no download/durable-storage/dedup pipeline (spec
 *   §18 explicitly lists durable image storage as a reportable, non-blocking dependency).
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
        CREATE TABLE IF NOT EXISTS canonical_users (
          id SERIAL PRIMARY KEY,
          total_approved_count INTEGER NOT NULL DEFAULT 0 CHECK (total_approved_count >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS linked_identities (
          id SERIAL PRIMARY KEY,
          canonical_user_id INTEGER NOT NULL REFERENCES canonical_users(id),
          platform TEXT NOT NULL DEFAULT 'whatsapp',
          identity TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (platform, identity)
        );

        CREATE TABLE IF NOT EXISTS postings (
          id SERIAL PRIMARY KEY,
          source_platform TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('chat', 'api')),
          source_chat_id TEXT,
          source_message_id TEXT,
          external_listing_id TEXT,
          canonical_user_id INTEGER REFERENCES canonical_users(id),
          source_identity TEXT,
          type TEXT NOT NULL CHECK (type IN ('FS', 'WTB')),
          original_text TEXT NOT NULL DEFAULT '',
          brand TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          reference TEXT NOT NULL DEFAULT '',
          dial TEXT NOT NULL DEFAULT '',
          material TEXT NOT NULL DEFAULT '',
          year TEXT NOT NULL DEFAULT '',
          condition TEXT NOT NULL DEFAULT '',
          box_papers TEXT NOT NULL DEFAULT '',
          price NUMERIC,
          currency TEXT NOT NULL DEFAULT 'USD',
          location TEXT NOT NULL DEFAULT '',
          country TEXT NOT NULL DEFAULT '',
          contact_name TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          detail_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          approved_match_count INTEGER NOT NULL DEFAULT 0 CHECK (approved_match_count >= 0),
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS postings_chat_identity
          ON postings (source_platform, source_chat_id, source_message_id)
          WHERE source_type = 'chat';
        CREATE UNIQUE INDEX IF NOT EXISTS postings_api_identity
          ON postings (source_platform, type, external_listing_id)
          WHERE source_type = 'api';
        CREATE INDEX IF NOT EXISTS postings_active_by_type
          ON postings (type, status, expires_at);

        CREATE TABLE IF NOT EXISTS posting_images (
          id SERIAL PRIMARY KEY,
          posting_id INTEGER NOT NULL REFERENCES postings(id),
          source_url TEXT NOT NULL,
          mime_type TEXT,
          size_bytes INTEGER,
          content_hash TEXT,
          display_order INTEGER NOT NULL DEFAULT 0,
          is_primary BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS posting_images_dedupe
          ON posting_images (posting_id, content_hash)
          WHERE content_hash IS NOT NULL;

        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          fs_posting_id INTEGER NOT NULL REFERENCES postings(id),
          wtb_posting_id INTEGER NOT NULL REFERENCES postings(id),
          score INTEGER NOT NULL DEFAULT 0,
          reasons TEXT[] NOT NULL DEFAULT '{}',
          matching_version TEXT NOT NULL DEFAULT 'v4.0',
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (fs_posting_id, wtb_posting_id)
        );

        CREATE TABLE IF NOT EXISTS match_recipients (
          id SERIAL PRIMARY KEY,
          match_id INTEGER NOT NULL REFERENCES matches(id),
          recipient_canonical_user_id INTEGER NOT NULL REFERENCES canonical_users(id),
          match_revision INTEGER NOT NULL,
          decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'passed')),
          notified_at TIMESTAMPTZ,
          decided_at TIMESTAMPTZ,
          connected_at TIMESTAMPTZ,
          UNIQUE (match_id, recipient_canonical_user_id, match_revision)
        );

        CREATE TABLE IF NOT EXISTS approvals (
          id SERIAL PRIMARY KEY,
          match_id INTEGER NOT NULL REFERENCES matches(id),
          approving_canonical_user_id INTEGER NOT NULL REFERENCES canonical_users(id),
          is_complimentary BOOLEAN NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (match_id, approving_canonical_user_id)
        );

        CREATE TABLE IF NOT EXISTS billing_ledger (
          id SERIAL PRIMARY KEY,
          canonical_user_id INTEGER NOT NULL REFERENCES canonical_users(id),
          match_id INTEGER REFERENCES matches(id),
          amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
          currency TEXT NOT NULL DEFAULT 'USD',
          billing_status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS reconciliation_runs (
          id SERIAL PRIMARY KEY,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at TIMESTAMPTZ,
          matches_created INTEGER,
          error TEXT
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

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`
    DROP TABLE IF EXISTS
      reconciliation_runs, billing_ledger, approvals, match_recipients, matches,
      posting_images, postings, linked_identities, canonical_users
    CASCADE
  `);
  schemaReady = null;
  await ensureSchema();
}

export async function _closePoolForTests(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}
