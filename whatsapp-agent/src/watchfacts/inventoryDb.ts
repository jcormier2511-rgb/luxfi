import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.data.inventoryDb), { recursive: true });
  db = new Database(config.data.inventoryDb);
  db.pragma("journal_mode = WAL");
  db.exec(`
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
      is_active INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (source, type, external_id)
    );
    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_success_at TEXT,
      last_attempt_at TEXT,
      last_error TEXT,
      fs_count INTEGER NOT NULL DEFAULT 0,
      wtb_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO sync_meta (id) VALUES (1);
  `);
  return db;
}

/** Test-only escape hatch — points the module at a fresh DB file/`:memory:` per test. */
export function _resetDbForTests(): void {
  db?.close();
  db = null;
}

interface UpsertRow {
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
}

/** Insert new listings, update existing ones (matched by source+type+external_id). */
export function upsertListings(rows: UpsertRow[], syncedAt: string, source = "WF"): void {
  const stmt = getDb().prepare(`
    INSERT INTO inventory_listings
      (source, type, external_id, category, item, brand, ref, condition, price, location,
       contact_name, contact_phone, rating, description, is_active, first_seen_at, last_seen_at)
    VALUES
      (@source, @type, @externalId, @category, @item, @brand, @ref, @condition, @price, @location,
       @contactName, @contactPhone, @rating, @description, 1, @syncedAt, @syncedAt)
    ON CONFLICT(source, type, external_id) DO UPDATE SET
      category=excluded.category, item=excluded.item, brand=excluded.brand, ref=excluded.ref,
      condition=excluded.condition, price=excluded.price, location=excluded.location,
      contact_name=excluded.contact_name, contact_phone=excluded.contact_phone,
      rating=excluded.rating, description=excluded.description,
      is_active=1, last_seen_at=excluded.last_seen_at
  `);
  const insertMany = getDb().transaction((items: UpsertRow[]) => {
    for (const r of items) {
      stmt.run({ ...r, externalId: r.id, source, syncedAt });
    }
  });
  insertMany(rows);
}

/**
 * Only called after a sync for `type` returned at least one row (see syncInventory.ts) —
 * marks anything of that source+type NOT in `seenExternalIds` inactive, so a transient 0-row
 * fetch can never wipe out inventory, only a real "this listing is gone" result can.
 */
export function markMissingInactive(source: string, type: ListingType, seenExternalIds: string[], syncedAt: string): void {
  if (seenExternalIds.length === 0) return;
  const placeholders = seenExternalIds.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE inventory_listings SET is_active = 0
       WHERE source = ? AND type = ? AND is_active = 1 AND external_id NOT IN (${placeholders})`
    )
    .run(source, type, ...seenExternalIds);
  void syncedAt; // kept in the signature for symmetry with upsertListings / future auditing
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

/** Active WatchFacts listings from the DB, merged with group-monitor CSV captures. */
export function getActiveListings(type?: ListingType): InventoryListing[] {
  const query = type
    ? getDb().prepare(`SELECT * FROM inventory_listings WHERE is_active = 1 AND type = ?`).all(type)
    : getDb().prepare(`SELECT * FROM inventory_listings WHERE is_active = 1`).all();
  const dbListings = (query as ListingRow[]).map(rowToListing);
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

export function getSyncStatus(): SyncStatus {
  const meta = getDb().prepare(`SELECT * FROM sync_meta WHERE id = 1`).get() as {
    last_success_at: string | null;
    last_attempt_at: string | null;
    last_error: string | null;
    fs_count: number;
    wtb_count: number;
  };
  const { count } = getDb().prepare(`SELECT COUNT(*) as count FROM inventory_listings WHERE is_active = 1`).get() as {
    count: number;
  };
  return {
    lastSuccessAt: meta.last_success_at,
    lastAttemptAt: meta.last_attempt_at,
    lastError: meta.last_error,
    fsCount: meta.fs_count,
    wtbCount: meta.wtb_count,
    totalActiveCount: count,
  };
}

export function recordSyncAttempt(): void {
  getDb().prepare(`UPDATE sync_meta SET last_attempt_at = ? WHERE id = 1`).run(new Date().toISOString());
}

export function recordSyncSuccess(fsCount: number, wtbCount: number): void {
  getDb()
    .prepare(`UPDATE sync_meta SET last_success_at = ?, last_error = NULL, fs_count = ?, wtb_count = ? WHERE id = 1`)
    .run(new Date().toISOString(), fsCount, wtbCount);
}

export function recordSyncError(message: string): void {
  getDb().prepare(`UPDATE sync_meta SET last_error = ? WHERE id = 1`).run(message);
}
