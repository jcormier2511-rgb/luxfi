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
        CREATE TABLE IF NOT EXISTS sync_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_success_at TIMESTAMPTZ,
          last_attempt_at TIMESTAMPTZ,
          last_error TEXT,
          fs_count INTEGER NOT NULL DEFAULT 0,
          wtb_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO sync_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
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

export interface SyncStatus {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  fsCount: number;
  wtbCount: number;
  totalActiveCount: number;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  await ensureSchema();
  const metaResult = await getPool().query(`SELECT * FROM sync_meta WHERE id = 1`);
  const meta = metaResult.rows[0] as {
    last_success_at: string | null;
    last_attempt_at: string | null;
    last_error: string | null;
    fs_count: number;
    wtb_count: number;
  };
  const countResult = await getPool().query(`SELECT COUNT(*)::int as count FROM inventory_listings WHERE is_active = TRUE`);
  return {
    lastSuccessAt: meta.last_success_at,
    lastAttemptAt: meta.last_attempt_at,
    lastError: meta.last_error,
    fsCount: meta.fs_count,
    wtbCount: meta.wtb_count,
    totalActiveCount: countResult.rows[0].count,
  };
}

export async function recordSyncAttempt(): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE sync_meta SET last_attempt_at = $1 WHERE id = 1`, [new Date().toISOString()]);
}

export async function recordSyncSuccess(fsCount: number, wtbCount: number): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE sync_meta SET last_success_at = $1, last_error = NULL, fs_count = $2, wtb_count = $3 WHERE id = 1`,
    [new Date().toISOString(), fsCount, wtbCount]
  );
}

export async function recordSyncError(message: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`UPDATE sync_meta SET last_error = $1 WHERE id = 1`, [message]);
}
