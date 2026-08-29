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
          -- Set to the exact expires_at value a reminder was last sent for (spec: remind once
          -- per posting/expiration "version"). Comparing against the CURRENT expires_at is what
          -- makes an extension (which changes expires_at) eligible for a fresh reminder without
          -- a separate "extended" flag — see findPostingsNeedingReminder/claimReminderForPosting.
          reminder_sent_for_expires_at TIMESTAMPTZ,
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

        -- Current scope (deliberately minimal): capture an already-accessible image URL
        -- (WatchFacts' own frontImage field, or a WhatsApp image message's media link) as
        -- source_url and use it directly in match notifications. mime_type/size_bytes/
        -- content_hash exist for a FUTURE durable-storage version (downloading the image,
        -- hashing it, deduplicating identical photos across postings, hosting it ourselves)
        -- that is explicitly DEFERRED — nothing today downloads, hashes, or permanently
        -- stores an image; a missing/expired/unreachable source_url just means no photo is
        -- shown, never a failure that blocks ingestion, matching, notification, approval, or
        -- sync (see notify.ts's getPrimaryImageUrl call site).
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
        CREATE UNIQUE INDEX IF NOT EXISTS posting_images_source_url_dedupe
          ON posting_images (posting_id, source_url);

        CREATE TABLE IF NOT EXISTS matches (
          id SERIAL PRIMARY KEY,
          fs_posting_id INTEGER NOT NULL REFERENCES postings(id),
          wtb_posting_id INTEGER NOT NULL REFERENCES postings(id),
          score INTEGER NOT NULL DEFAULT 0,
          reasons TEXT[] NOT NULL DEFAULT '{}',
          matching_version TEXT NOT NULL DEFAULT 'v4.0',
          revision INTEGER NOT NULL DEFAULT 1,
          -- Match-level connection record (spec: "creates one idempotent introduction/
          -- connection record... stores pending_confirmation, connected, or equivalent
          -- status"). NULL = pending_confirmation; set once both sides have confirmed (or
          -- once the one side that can confirm has, when the other has no WhatsApp identity
          -- to confirm at all — see notify.ts's approveMatch). Never cleared once set.
          connected_at TIMESTAMPTZ,
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
          -- Per-side idempotency claim: set exactly once, the moment THIS recipient is
          -- actually shown/sent the counterpart's contact info (immediately if the
          -- counterpart needs no confirmation, or retroactively once the counterpart also
          -- approves) — never re-triggers a send once set. See notify.ts's approveMatch.
          connected_at TIMESTAMPTZ,
          UNIQUE (match_id, recipient_canonical_user_id, match_revision)
        );

        CREATE TABLE IF NOT EXISTS approvals (
          id SERIAL PRIMARY KEY,
          -- Nullable (see the ALTER below) for the v3 on-demand flow's own approvals — that
          -- flow's "matches" are ephemeral live-search results, never a real row in the
          -- matches table, so it records approval usage against the SAME canonical_users
          -- counter v4 uses (see postings/approvalUsage.ts) with no match_id at all. Multiple
          -- NULL match_ids for the same approver never collide with the UNIQUE constraint
          -- below (Postgres never considers NULLs equal) — v3 doesn't need that dedup anyway,
          -- since it already has its own state-machine-level idempotency (flow.ts's
          -- pending.decisions[idx] check).
          match_id INTEGER REFERENCES matches(id),
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

        -- Spec §14 admin visibility: "notifications sent and failed." Sent is always counted
        -- live from match_recipients.notified_at (the real source of truth); failed has no
        -- other record anywhere (a failed sendText was only ever console.error'd), so this
        -- singleton row is the one thing that actually needs its own persisted counter.
        CREATE TABLE IF NOT EXISTS postings_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          notifications_failed_count INTEGER NOT NULL DEFAULT 0,
          last_notification_error TEXT,
          last_notification_error_at TIMESTAMPTZ
        );
        INSERT INTO postings_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

        -- Additive migrations for columns introduced after their table's original
        -- CREATE TABLE — CREATE TABLE IF NOT EXISTS silently skips a table that already
        -- exists, so a column added later needs its own idempotent ADD COLUMN IF NOT EXISTS
        -- to actually reach a database that already has an older version of these tables.
        ALTER TABLE postings ADD COLUMN IF NOT EXISTS reminder_sent_for_expires_at TIMESTAMPTZ;
        ALTER TABLE matches ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ;

        -- Lets the v3 on-demand flow's own approvals share this table (see the CREATE TABLE
        -- approvals comment above) — an existing deployed database still has the original
        -- NOT NULL from before this column was widened.
        ALTER TABLE approvals ALTER COLUMN match_id DROP NOT NULL;

        -- Durable "my approved matches" summary (see postings/approvalUsage.ts's
        -- getApprovedMatchesSummary, conversation/flow.ts's "listings" command) — the watch
        -- itself (never sensitive, safe to store at decision time) plus whichever counterpart
        -- contact this approver has actually been shown. counterpart_name/counterpart_phone
        -- are deliberately NULL until markApprovalRevealed runs — never populated at insert
        -- time for a v4 approval whose mutual confirmation isn't complete yet, so this summary
        -- can never leak a contact before the same rules that gate the live reveal allow it.
        -- v3's own approvals (no confirmation gate at all) populate all three immediately.
        ALTER TABLE approvals ADD COLUMN IF NOT EXISTS listing_description TEXT;
        ALTER TABLE approvals ADD COLUMN IF NOT EXISTS counterpart_name TEXT;
        ALTER TABLE approvals ADD COLUMN IF NOT EXISTS counterpart_phone TEXT;

        -- Widens source_type for the private "sell a watch" conversational intake
        -- (conversation/flow.ts's sell-intake flow, see postingsStore.ts's createDirectPosting):
        -- a person telling Fi directly what they're selling, as distinct from 'chat' (a passively
        -- monitored group message) or 'api' (a mirrored WatchFacts listing). Deliberately its own
        -- value rather than reusing 'chat' or 'api' — isPostingChatEnabled (config.ts) already
        -- treats any non-'chat' source_type as never chat-gated, which is exactly right here: a
        -- direct 1:1 request carries its own explicit consent and needs none of the group-chat
        -- allowlist rollout controls 'chat' postings do.
        ALTER TABLE postings DROP CONSTRAINT IF EXISTS postings_source_type_check;
        ALTER TABLE postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('chat', 'api', 'direct'));
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

/**
 * Explicit startup entry point — called unconditionally in index.ts regardless of
 * ENABLE_V4_POSTINGS, so the additive v4 schema is created/validated in production well
 * before the flag is ever turned on, rather than surfacing a migration surprise at that
 * moment. Only creates tables/indexes (all IF NOT EXISTS) — never touches postings data and
 * never sends a message, so calling it while v4 is disabled has no user-visible effect.
 * Idempotent: safe to call any number of times (ensureSchema caches the promise per process).
 */
export async function initSchema(): Promise<void> {
  await ensureSchema();
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
      reconciliation_runs, postings_meta, billing_ledger, approvals, match_recipients, matches,
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
