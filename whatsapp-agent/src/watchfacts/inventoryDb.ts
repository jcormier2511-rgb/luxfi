import fs from "fs";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";

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
        CREATE TABLE IF NOT EXISTS inventory_listings (
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          item TEXT NOT NULL DEFAULT '',
          brand TEXT NOT NULL DEFAULT '',
          ref TEXT NOT NULL DEFAULT '',
          condition TEXT NOT NULL DEFAULT '',
          price TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          contact_name TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          rating TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          detail_url TEXT NOT NULL DEFAULT '',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (source, type, external_id)
        );
        -- Legacy columns (last_success_at/last_error/fs_count/wtb_count) are created here too,
        -- even on a brand-new table, so a rollback to the previous deployed version — which
        -- still reads/writes only those columns — keeps working against this same schema
        -- without a second migration. They are NOT written to going forward by this version;
        -- see the backfill comment below for how they stay non-empty despite that.
        CREATE TABLE IF NOT EXISTS sync_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_attempt_at TIMESTAMPTZ,
          last_success_at TIMESTAMPTZ,
          last_error TEXT,
          fs_count INTEGER NOT NULL DEFAULT 0,
          wtb_count INTEGER NOT NULL DEFAULT 0
        );
        -- Additive migration for a table created by an earlier deploy (which only had the
        -- legacy columns above): add the new per-type columns. Legacy columns are
        -- deliberately kept (not dropped) so a Railway rollback to the previous version can
        -- still operate against this same, now-migrated-forward table.
        ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS fs_last_success_at TIMESTAMPTZ;
        ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS fs_last_error TEXT;
        ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS wtb_last_success_at TIMESTAMPTZ;
        ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS wtb_last_error TEXT;
        INSERT INTO sync_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
        -- Backfill: the legacy schema had one shared status for both sides, so on first
        -- migration (before this version has ever written its own per-type columns) seed
        -- both FS and WTB from whatever the old shared value was — the best available
        -- approximation, since the old schema can't tell us which side it came from. Each
        -- UPDATE is guarded on the new column still being NULL, so this never overwrites a
        -- real value written by this version's own recordTypeSyncSuccess/Error, and is safe
        -- to re-run every boot (idempotent).
        UPDATE sync_meta SET fs_last_success_at = last_success_at
          WHERE fs_last_success_at IS NULL AND last_success_at IS NOT NULL;
        UPDATE sync_meta SET wtb_last_success_at = last_success_at
          WHERE wtb_last_success_at IS NULL AND last_success_at IS NOT NULL;
        UPDATE sync_meta SET fs_last_error = last_error
          WHERE fs_last_error IS NULL AND last_error IS NOT NULL;
        UPDATE sync_meta SET wtb_last_error = last_error
          WHERE wtb_last_error IS NULL AND last_error IS NOT NULL;
        `
      )
      .then(() => undefined);
  }
  await schemaReady;
}

/**
 * Test-only escape hatch — drops the schema and forces a fresh migration next call. Always
 * connects first rather than skipping the drop when `pool` is still null: this is a real,
 * persistent Postgres database now (not `:memory:` SQLite), so a fresh test process's very
 * first call here still has leftover rows from the previous run sitting in the table unless
 * it actually connects and drops them.
 */
export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`DROP TABLE IF EXISTS inventory_listings, sync_meta`);
  schemaReady = null;
  await ensureSchema();
}

/** Test-only — closes the connection pool so the test runner's process can exit. */
export async function _closePoolForTests(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}

/**
 * Test-only — forces the next call through ensureSchema() to actually re-run its migration
 * SQL, without dropping any tables first (unlike _resetDbForTests). Lets a test seed a raw
 * "old schema" table directly via its own client, then verify this version's migration
 * upgrades it correctly in place.
 */
export function _forceSchemaRecheckForTests(): void {
  schemaReady = null;
}

export interface UpsertRow {
  id: string;
  type: ListingType;
  category: string;
  item: string;
  brand: string;
  ref: string;
  condition: string;
  price: string;
  location: string;
  contactName: string;
  contactPhone: string;
  rating: string;
  description: string;
  detailUrl?: string;
}

/** Insert new listings, update existing ones (matched by source+type+external_id). */
export async function upsertListings(rows: UpsertRow[], syncedAt: string, source = "WF"): Promise<void> {
  if (rows.length === 0) return;
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `
        INSERT INTO inventory_listings
          (source, type, external_id, category, item, brand, ref, condition, price, location,
           contact_name, contact_phone, rating, description, detail_url, is_active, first_seen_at, last_seen_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, $16, $16)
        ON CONFLICT (source, type, external_id) DO UPDATE SET
          category = excluded.category, item = excluded.item, brand = excluded.brand, ref = excluded.ref,
          condition = excluded.condition, price = excluded.price, location = excluded.location,
          contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
          rating = excluded.rating, description = excluded.description, detail_url = excluded.detail_url,
          is_active = TRUE, last_seen_at = excluded.last_seen_at
        `,
        [
          source,
          r.type,
          r.id,
          r.category,
          r.item,
          r.brand,
          r.ref,
          r.condition,
          r.price,
          r.location,
          r.contactName,
          r.contactPhone,
          r.rating,
          r.description,
          r.detailUrl ?? "",
          syncedAt,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Only called after a sync for `type` returned at least one row (see syncInventory.ts) —
 * marks anything of that source+type NOT in `seenExternalIds` inactive, so a transient 0-row
 * fetch can never wipe out inventory, only a real "this listing is gone" result can.
 */
export async function markMissingInactive(
  source: string,
  type: ListingType,
  seenExternalIds: string[],
  syncedAt: string
): Promise<void> {
  if (seenExternalIds.length === 0) return;
  await ensureSchema();
  void syncedAt; // kept in the signature for symmetry with upsertListings / future auditing
  await getPool().query(
    `UPDATE inventory_listings SET is_active = FALSE
     WHERE source = $1 AND type = $2 AND is_active = TRUE AND external_id <> ALL($3::text[])`,
    [source, type, seenExternalIds]
  );
}

interface ListingRow {
  type: string;
  category: string;
  item: string;
  brand: string;
  ref: string;
  condition: string;
  price: string;
  location: string;
  contact_name: string;
  contact_phone: string;
  source: string;
  rating: string;
  description: string;
  detail_url: string;
  external_id: string;
}

function rowToListing(row: ListingRow): InventoryListing {
  return {
    id: row.external_id,
    type: row.type as ListingType,
    category: row.category,
    item: row.item,
    brand: row.brand,
    ref: row.ref,
    condition: row.condition,
    price: row.price,
    location: row.location,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    source: row.source,
    rating: row.rating,
    description: row.description,
    detailUrl: row.detail_url || undefined,
  };
}

function loadGroupListings(type?: ListingType): InventoryListing[] {
  if (!fs.existsSync(config.data.groupListingsCsv)) return [];
  const raw = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows
    .map(
      (row): InventoryListing => ({
        id: row.id,
        type: (row.type?.toUpperCase() as ListingType) ?? "FS",
        category: row.category,
        item: row.item,
        brand: row.brand,
        ref: row.ref,
        condition: row.condition,
        price: row.price,
        location: row.location,
        contactName: row.contact_name,
        contactPhone: row.contact_phone,
        source: row.source || "WA-Group",
        rating: row.rating || "",
        description: row.description || "",
      })
    )
    .filter((l) => !type || l.type === type);
}

/** Active WatchFacts listings from Postgres, merged with group-monitor CSV captures. */
export async function getActiveListings(type?: ListingType): Promise<InventoryListing[]> {
  await ensureSchema();
  const result = type
    ? await getPool().query(`SELECT * FROM inventory_listings WHERE is_active = TRUE AND type = $1`, [type])
    : await getPool().query(`SELECT * FROM inventory_listings WHERE is_active = TRUE`);
  const dbListings = (result.rows as ListingRow[]).map(rowToListing);
  return [...dbListings, ...loadGroupListings(type)];
}

export interface DiagnosticListingRow {
  externalId: string;
  type: string;
  ref: string;
  item: string;
  description: string;
  isActive: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Read-only diagnostic search across ACTIVE AND INACTIVE rows (unlike getActiveListings), so a
 * production investigation can see whether a listing exists at all, what's actually stored in
 * `ref`/`item`/`description`, whether it's been marked inactive, and whether `last_seen_at`
 * reflects a recent sync — without needing raw DB credentials. Matches a case-insensitive
 * substring against ref, item, or description. Exposed via GET /admin/inventory-search.
 */
export async function searchListingsForDiagnostics(term: string): Promise<DiagnosticListingRow[]> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT external_id, type, ref, item, description, is_active, first_seen_at, last_seen_at
     FROM inventory_listings
     WHERE ref ILIKE $1 OR item ILIKE $1 OR description ILIKE $1
     ORDER BY last_seen_at DESC
     LIMIT 50`,
    [`%${term}%`]
  );
  return result.rows.map((row) => ({
    externalId: row.external_id,
    type: row.type,
    ref: row.ref,
    item: row.item.length > 200 ? row.item.slice(0, 200) + "…" : row.item,
    description: row.description.length > 200 ? row.description.slice(0, 200) + "…" : row.description,
    isActive: row.is_active,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export type TypeSyncState = "ok" | "error" | "disabled" | "never_run";

export interface TypeSyncStatus {
  status: TypeSyncState;
  lastSuccessAt: string | null;
  lastError: string | null;
  activeCount: number;
}

export interface SyncStatus {
  lastAttemptAt: string | null;
  fs: TypeSyncStatus;
  wtb: TypeSyncStatus;
  totalActiveCount: number;
}

/**
 * FS and WTB are tracked separately (spec requirement, and a real bug this fixes): the two
 * sides of a sync can succeed/fail independently — e.g. WTB failing to resolve its
 * auction_type shouldn't erase or mask that FS just succeeded. See runInventorySync().
 */
/** pg returns TIMESTAMPTZ columns as Date objects, not strings — coerce so the `string | null`
 *  types in SyncStatus are actually honest rather than lying about the runtime shape. */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function deriveState(enabled: boolean, lastSuccessAt: string | null, lastError: string | null): TypeSyncState {
  if (!enabled) return "disabled";
  if (lastError) return "error";
  if (lastSuccessAt) return "ok";
  return "never_run";
}

/**
 * `wtbEnabled` reflects config.watchfacts.enableWtbSync — when false, WTB is reported as
 * "disabled" (status + activeCount from whatever's already in the DB, but lastError forced
 * to null) rather than showing a stale or misleading error from before the flag was turned
 * off. This function stays free of the config import itself; the caller (server.ts) passes
 * the flag in, keeping this module's own concerns limited to the database.
 */
export async function getSyncStatus(wtbEnabled: boolean): Promise<SyncStatus> {
  await ensureSchema();
  const metaResult = await getPool().query(`SELECT * FROM sync_meta WHERE id = 1`);
  const meta = metaResult.rows[0] as {
    last_attempt_at: Date | string | null;
    fs_last_success_at: Date | string | null;
    fs_last_error: string | null;
    wtb_last_success_at: Date | string | null;
    wtb_last_error: string | null;
  };
  const countsResult = await getPool().query(
    `SELECT type, COUNT(*)::int as count FROM inventory_listings WHERE is_active = TRUE GROUP BY type`
  );
  const counts: Record<string, number> = { FS: 0, WTB: 0 };
  for (const row of countsResult.rows as { type: string; count: number }[]) counts[row.type] = row.count;

  const fsLastSuccessAt = toIso(meta.fs_last_success_at);
  const wtbLastSuccessAt = wtbEnabled ? toIso(meta.wtb_last_success_at) : null;
  const wtbLastError = wtbEnabled ? meta.wtb_last_error : null;

  return {
    lastAttemptAt: toIso(meta.last_attempt_at),
    fs: {
      status: deriveState(true, fsLastSuccessAt, meta.fs_last_error),
      lastSuccessAt: fsLastSuccessAt,
      lastError: meta.fs_last_error,
      activeCount: counts.FS,
    },
    wtb: {
      status: deriveState(wtbEnabled, wtbLastSuccessAt, wtbLastError),
      lastSuccessAt: wtbLastSuccessAt,
      lastError: wtbLastError,
      activeCount: counts.WTB,
    },
    totalActiveCount: counts.FS + counts.WTB,
  };
}

export async function recordSyncAttempt(): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE sync_meta SET last_attempt_at = $1 WHERE id = 1`, [new Date().toISOString()]);
}

export async function recordTypeSyncSuccess(type: ListingType): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  if (type === "FS") {
    await getPool().query(`UPDATE sync_meta SET fs_last_success_at = $1, fs_last_error = NULL WHERE id = 1`, [now]);
  } else {
    await getPool().query(`UPDATE sync_meta SET wtb_last_success_at = $1, wtb_last_error = NULL WHERE id = 1`, [now]);
  }
}

export async function recordTypeSyncError(type: ListingType, message: string): Promise<void> {
  await ensureSchema();
  if (type === "FS") {
    await getPool().query(`UPDATE sync_meta SET fs_last_error = $1 WHERE id = 1`, [message]);
  } else {
    await getPool().query(`UPDATE sync_meta SET wtb_last_error = $1 WHERE id = 1`, [message]);
  }
}
