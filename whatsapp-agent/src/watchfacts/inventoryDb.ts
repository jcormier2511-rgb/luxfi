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
        -- AI enrichment cache (hybrid matching, ENABLE_AI_MATCHING) — deliberately its own
        -- table, keyed on the ORIGINAL pre-split external id, rather than columns on
        -- inventory_listings: an unstructured bundle blast gets split into several derived
        -- rows with their OWN ids (see watchfacts/aiEnrich.ts), so a hash/enrichment saved
        -- against inventory_listings' row would never be found again for that original id on
        -- the next sync. Keeping the cache decoupled from inventory_listings' row lifecycle
        -- means content-hash caching works the same way whether or not a given sync happened
        -- to split that content into multiple rows.
        CREATE TABLE IF NOT EXISTS ai_enrichment_cache (
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          external_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          enrichment JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (source, type, external_id)
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
        -- Private "request photos before approval" workflow (Fi v4 matching). Additive columns
        -- on the existing row, keyed the same way (source, type, external_id) as every other
        -- listing field — deliberately NOT included in upsertListings' ON CONFLICT SET clause
        -- below, so a routine WatchFacts re-sync can never clobber an in-progress photo request.
        -- image_url is the one exception: it's synced data (WatchFacts' own frontImage), not
        -- request state, so it DOES get refreshed on every sync like every other listing field.
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS photo_request_status TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS photo_requested_at TIMESTAMPTZ;
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS photo_requester_phone TEXT;
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS photo_request_match_id TEXT;
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS requested_photos JSONB NOT NULL DEFAULT '[]';
        -- Automatic currency conversion (src/fx/) — the listing's OWN stated price/currency,
        -- kept separate from the existing price column (which stays the plain numeric string
        -- every existing filter/display path already relies on) so the original is never
        -- overwritten by a converted value. Synced data, refreshed on every sync like image_url.
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS native_price_amount DOUBLE PRECISION;
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS native_currency TEXT;
        ALTER TABLE inventory_listings ADD COLUMN IF NOT EXISTS original_price_text TEXT;
        -- Exact-reference Market Pulse reads only normalized, currently-active inventory.
        -- Keep that read indexed; price/last_seen_at are included so Postgres can satisfy
        -- the aggregation from the index on installations that support index-only scans.
        CREATE INDEX IF NOT EXISTS inventory_listings_market_pulse
          ON inventory_listings (upper(ref), type, is_active, last_seen_at)
          INCLUDE (price, native_price_amount, native_currency);
        -- Full-catalogue scale. Every customer-facing read now narrows on
        -- (is_active, type, first_seen_at) -- the freshness window is measured on first_seen_at,
        -- which the market-pulse index above does not cover -- and, when the request names a
        -- reference, on the SAME normalized-reference expression that market pulse and
        -- findCandidateListings both compare with. text_pattern_ops so the prefix half of
        -- referencesMatch ("116500" finding "116500LN") can use the index rather than scanning.
        CREATE INDEX IF NOT EXISTS inventory_listings_active_recent
          ON inventory_listings (is_active, type, first_seen_at DESC);
        CREATE INDEX IF NOT EXISTS inventory_listings_normalized_ref
          ON inventory_listings (upper(regexp_replace(COALESCE(ref,''), '[^A-Za-z0-9]', '', 'g')) text_pattern_ops, is_active, type);
        `
      )
      .then(() => undefined);
  }
  await schemaReady;
}

/** Ensure the existing inventory schema is available to other read-only database features. */
export async function initInventorySchema(): Promise<void> {
  await ensureSchema();
}

/**
 * Test-only escape hatch — drops the schema and forces a fresh migration next call. Always
 * connects first rather than skipping the drop when `pool` is still null: this is a real,
 * persistent Postgres database now (not `:memory:` SQLite), so a fresh test process's very
 * first call here still has leftover rows from the previous run sitting in the table unless
 * it actually connects and drops them.
 */
export async function _resetDbForTests(): Promise<void> {
  await getPool().query(`DROP TABLE IF EXISTS inventory_listings, sync_meta, ai_enrichment_cache`);
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
  imageUrl?: string;
  nativePriceAmount?: number;
  nativeCurrency?: string;
  originalPriceText?: string;
}

/** The 19 per-listing values, in the column order upsertListings inserts them. */
function upsertValues(r: UpsertRow, syncedAt: string, source: string): unknown[] {
  return [
    source, r.type, r.id, r.category, r.item, r.brand, r.ref, r.condition, r.price, r.location,
    r.contactName, r.contactPhone, r.rating, r.description, r.detailUrl ?? "", r.imageUrl ?? "",
    r.nativePriceAmount ?? null, r.nativeCurrency ?? null, r.originalPriceText ?? null, syncedAt,
  ];
}
const UPSERT_COLUMNS = 20; // the 19 listing values plus syncedAt, which fills both timestamps

/**
 * Insert new listings, update existing ones (matched by source+type+external_id).
 *
 * Written as multi-row INSERTs rather than one statement per listing: a full catalogue is on
 * the order of a million rows, and a statement each means a million round trips inside one
 * transaction. Still one transaction for the whole call, so a sync that fails partway leaves
 * the previous inventory intact rather than half-replaced.
 *
 * first_seen_at is deliberately NOT updated on conflict — a listing that keeps re-appearing in
 * syncs keeps its original age, which is what the freshness window measures.
 */
export async function upsertListings(rows: UpsertRow[], syncedAt: string, source = "WF"): Promise<void> {
  if (rows.length === 0) return;
  await ensureSchema();
  // Postgres refuses an ON CONFLICT DO UPDATE that would touch the same row twice in ONE
  // statement, so a key repeated inside a batch is an error rather than the harmless overwrite
  // it was when this ran a statement per listing. Paging a live, date-sorted catalogue really
  // does re-serve a listing across page boundaries, so dedupe first, keeping the LAST
  // occurrence — the same row the old loop would have left behind.
  const deduped = [...new Map(rows.map((r) => [`${source}\u0000${r.type}\u0000${r.id}`, r])).values()];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (let offset = 0; offset < deduped.length; offset += config.watchfacts.syncBatchSize) {
      const batch = deduped.slice(offset, offset + config.watchfacts.syncBatchSize);
      const tuples = batch.map((_, i) => {
        const base = i * UPSERT_COLUMNS;
        const p = (n: number) => `$${base + n}`;
        // $20 is syncedAt, used for BOTH first_seen_at and last_seen_at on a fresh insert.
        return `(${Array.from({ length: 19 }, (_, c) => p(c + 1)).join(", ")}, TRUE, ${p(20)}, ${p(20)})`;
      });
      await client.query(
        `
        INSERT INTO inventory_listings
          (source, type, external_id, category, item, brand, ref, condition, price, location,
           contact_name, contact_phone, rating, description, detail_url, image_url,
           native_price_amount, native_currency, original_price_text, is_active, first_seen_at, last_seen_at)
        VALUES
          ${tuples.join(",\n          ")}
        ON CONFLICT (source, type, external_id) DO UPDATE SET
          category = excluded.category, item = excluded.item, brand = excluded.brand, ref = excluded.ref,
          condition = excluded.condition, price = excluded.price, location = excluded.location,
          contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
          rating = excluded.rating, description = excluded.description, detail_url = excluded.detail_url,
          image_url = excluded.image_url, native_price_amount = excluded.native_price_amount,
          native_currency = excluded.native_currency, original_price_text = excluded.original_price_text,
          is_active = TRUE, last_seen_at = excluded.last_seen_at
        `,
        batch.flatMap((r) => upsertValues(r, syncedAt, source))
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
 * marks anything of that source+type the sync did NOT see inactive, so a transient 0-row fetch
 * can never wipe out inventory, only a real "this listing is gone" result can.
 *
 * "Did not see" is decided by last_seen_at, not by shipping the seen ids back to Postgres.
 * upsertListings has just stamped every seen row's last_seen_at with this run's `syncedAt`, so
 * anything still carrying an older timestamp is exactly what the sync didn't return — and a
 * full catalogue's worth of ids is not something to send as a query parameter. `seenExternalIds`
 * is kept in the signature as the caller's own "the fetch was non-empty" guard.
 */
export async function markMissingInactive(
  source: string,
  type: ListingType,
  seenExternalIds: string[],
  syncedAt: string
): Promise<void> {
  if (seenExternalIds.length === 0) return;
  await ensureSchema();
  await getPool().query(
    `UPDATE inventory_listings SET is_active = FALSE
     WHERE source = $1 AND type = $2 AND is_active = TRUE AND last_seen_at < $3`,
    [source, type, syncedAt]
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
  image_url: string;
  external_id: string;
  native_price_amount: number | string | null;
  native_currency: string | null;
  original_price_text: string | null;
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
    imageUrl: row.image_url || undefined,
    nativePriceAmount: row.native_price_amount === null ? undefined : Number(row.native_price_amount),
    nativeCurrency: row.native_currency ?? undefined,
    originalPriceText: row.original_price_text ?? undefined,
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

/**
 * The freshness half of "is this listing showable", as a SQL fragment on `alias`, so matching
 * (getActiveListings below) and market pulse (postings/marketPulse.ts) apply ONE definition of
 * stale rather than two that can drift apart. Always pair it with `is_active = TRUE`.
 *
 * The interval is built from config, not from a bound parameter, because Postgres will not
 * accept a placeholder inside an interval literal. config.watchfacts.maxListingAgeDays is
 * coerced to a non-negative integer at load (see config.ts), so nothing user-supplied reaches
 * this string. 0 disables the window and yields a constant-true predicate.
 */
export function freshInventorySql(alias: string): string {
  const days = config.watchfacts.maxListingAgeDays;
  return days > 0 ? `${alias}.first_seen_at > now() - interval '${days} days'` : "TRUE";
}

/** The normalized-reference expression, written once. Must stay identical to
 *  postings/normalize.ts's normalizeReference (strip non-alphanumerics, uppercase) and to the
 *  expression the inventory_listings_normalized_ref index is built on. */
const NORMALIZED_REF_SQL = "upper(regexp_replace(COALESCE(ref,''), '[^A-Za-z0-9]', '', 'g'))";

/** Every non-empty prefix of `ref`, longest first — the finite set of stored references that
 *  `ref` itself is a prefix-extension of. See referenceClauseFor. */
function referencePrefixes(ref: string): string[] {
  return Array.from({ length: ref.length }, (_, i) => ref.slice(0, i + 1));
}

export interface CandidateQuery {
  type?: ListingType;
  /** The reference the request named, if any. Narrows in SQL by the SAME rule the caller's own
   *  referencesMatch applies, so narrowing can never drop a listing the caller would have kept. */
  reference?: string | null;
  /** Keep listings that state NO reference of their own, even when `reference` is set. The
   *  hybrid/AI path treats an unreferenced listing as still eligible (only an explicitly
   *  CONFLICTING reference disqualifies one); plain findMatches requires a reference match. */
  includeUnreferenced?: boolean;
  /** Ceiling on rows read. Defaults to config.watchfacts.maxCandidateListings. */
  limit?: number;
}

/**
 * Candidate inventory for one search, narrowed IN SQL rather than in Node.
 *
 * getActiveListings below loads every active listing and leaves all selection to the caller.
 * That is exactly right for a few hundred flash sales and impossible for a full catalogue: it
 * would pull the whole table over the wire, and run FX normalization across it, on every single
 * inbound message. This does the narrowing the database is good at and leaves the caller's
 * ranking semantics untouched.
 *
 * Two cases, and the distinction matters:
 *
 *  - The request NAMES a reference. matching/engine.ts can only ever return listings satisfying
 *    referencesMatch(listing.ref, requested) — prefix-equal in either direction — so applying
 *    that same rule here is loss-free at any scale, not an approximation.
 *  - The request names no reference. Ranking is over the whole pool with a fallback that keeps
 *    the pool even when nothing scores, so there is nothing safe to narrow ON; the only lever
 *    is a ceiling, newest first. Below the ceiling the pool is exactly what it always was.
 *
 * Group-monitor CSV captures are merged in whole, as getActiveListings does: they are few, they
 * never live in Postgres, and the caller's own filters still apply to them.
 */
export async function findCandidateListings(query: CandidateQuery = {}): Promise<InventoryListing[]> {
  await ensureSchema();
  const limit = query.limit ?? config.watchfacts.maxCandidateListings;
  const where = [`is_active = TRUE`, freshInventorySql("inventory_listings")];
  const params: unknown[] = [];

  if (query.type) { params.push(query.type); where.push(`type = $${params.length}`); }

  const normalizedRef = (query.reference ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedRef) {
    // referencesMatch(a, b) is `na === nb || na.startsWith(nb) || nb.startsWith(na)`. The first
    // two collapse to "the stored reference starts with the requested one"; the third says the
    // stored reference is one of the requested one's own prefixes, which is a finite list.
    params.push(`${normalizedRef}%`);
    const likeParam = params.length;
    params.push(referencePrefixes(normalizedRef));
    const matches = `${NORMALIZED_REF_SQL} <> '' AND (${NORMALIZED_REF_SQL} LIKE $${likeParam} OR ${NORMALIZED_REF_SQL} = ANY($${params.length}::text[]))`;
    where.push(query.includeUnreferenced ? `(${NORMALIZED_REF_SQL} = '' OR (${matches}))` : matches);
  }

  params.push(limit);
  const result = await getPool().query(
    `SELECT * FROM inventory_listings WHERE ${where.join(" AND ")} ORDER BY first_seen_at DESC LIMIT $${params.length}`,
    params
  );
  return [...(result.rows as ListingRow[]).map(rowToListing), ...loadGroupListings(query.type)];
}

/** Active, non-stale WatchFacts listings from Postgres, merged with group-monitor CSV captures. */
export async function getActiveListings(type?: ListingType): Promise<InventoryListing[]> {
  await ensureSchema();
  const fresh = freshInventorySql("inventory_listings");
  const result = type
    ? await getPool().query(`SELECT * FROM inventory_listings WHERE is_active = TRUE AND ${fresh} AND type = $1`, [type])
    : await getPool().query(`SELECT * FROM inventory_listings WHERE is_active = TRUE AND ${fresh}`);
  const dbListings = (result.rows as ListingRow[]).map(rowToListing);
  return [...dbListings, ...loadGroupListings(type)];
}

/** One listing by its exact identity — used by the photo-request workflow to rebuild a full
 *  Match Card once a seller's photos have come in. */
export async function getListingByKey(source: string, type: ListingType, externalId: string): Promise<InventoryListing | null> {
  await ensureSchema();
  const result = await getPool().query(`SELECT * FROM inventory_listings WHERE source = $1 AND type = $2 AND external_id = $3`, [
    source,
    type,
    externalId,
  ]);
  const row = result.rows[0] as ListingRow | undefined;
  return row ? rowToListing(row) : null;
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

/** Content hashes of everything already enriched for `source`, keyed `${type}:${externalId}`. */
export async function getStoredAiHashes(source: string): Promise<Map<string, string>> {
  await ensureSchema();
  const result = await getPool().query(`SELECT type, external_id, content_hash FROM ai_enrichment_cache WHERE source = $1`, [source]);
  const map = new Map<string, string>();
  for (const row of result.rows) map.set(`${row.type}:${row.external_id}`, row.content_hash);
  return map;
}

export async function saveAiEnrichment(source: string, type: ListingType, externalId: string, hash: string, enrichment: unknown): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO ai_enrichment_cache (source, type, external_id, content_hash, enrichment, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (source, type, external_id) DO UPDATE SET
       content_hash = excluded.content_hash, enrichment = excluded.enrichment, updated_at = now()`,
    [source, type, externalId, hash, JSON.stringify(enrichment)]
  );
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

/**
 * Private "request photos before approval" workflow (Fi v4 matching) — persistence for the
 * additive photo-request columns on inventory_listings. Deliberately kept in this module rather
 * than a new one: these columns live on the same row every other listing field does, keyed the
 * same way (source, type, external_id).
 */
export type PhotoRequestStatus = "none" | "requested" | "received" | "unavailable";

export interface PhotoMediaEntry {
  url: string;
  receivedAt: string;
}

export interface PhotoRequestRecord {
  source: string;
  type: ListingType;
  externalId: string;
  contactPhone: string;
  status: PhotoRequestStatus;
  requestedAt: string | null;
  requesterPhone: string | null;
  matchId: string | null;
  photos: PhotoMediaEntry[];
}

interface PhotoRequestRow {
  source: string;
  type: string;
  external_id: string;
  contact_phone: string;
  photo_request_status: string;
  photo_requested_at: Date | string | null;
  photo_requester_phone: string | null;
  photo_request_match_id: string | null;
  requested_photos: PhotoMediaEntry[];
}

function rowToPhotoRequestRecord(row: PhotoRequestRow): PhotoRequestRecord {
  return {
    source: row.source,
    type: row.type as ListingType,
    externalId: row.external_id,
    contactPhone: row.contact_phone,
    status: row.photo_request_status as PhotoRequestStatus,
    requestedAt: toIso(row.photo_requested_at),
    requesterPhone: row.photo_requester_phone,
    matchId: row.photo_request_match_id,
    photos: row.requested_photos ?? [],
  };
}

const PHOTO_REQUEST_SELECT = `SELECT source, type, external_id, contact_phone, photo_request_status, photo_requested_at,
     photo_requester_phone, photo_request_match_id, requested_photos FROM inventory_listings`;

/** The exact identity + current photo-request state of one listing — used to decide whether a
 *  new request would be a duplicate, and who a fulfilled request should be delivered to. */
export async function getPhotoRequestRecord(source: string, type: ListingType, externalId: string): Promise<PhotoRequestRecord | null> {
  await ensureSchema();
  const result = await getPool().query(`${PHOTO_REQUEST_SELECT} WHERE source = $1 AND type = $2 AND external_id = $3`, [
    source,
    type,
    externalId,
  ]);
  const row = result.rows[0] as PhotoRequestRow | undefined;
  return row ? rowToPhotoRequestRecord(row) : null;
}

/** Starts a fresh request cycle — resets any previously collected photos, since this is a new
 *  request (possibly from a different requester) rather than a continuation of an old one. */
export async function markPhotoRequested(
  source: string,
  type: ListingType,
  externalId: string,
  requesterPhone: string,
  matchId: string
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE inventory_listings
     SET photo_request_status = 'requested', photo_requested_at = now(),
         photo_requester_phone = $4, photo_request_match_id = $5, requested_photos = '[]'
     WHERE source = $1 AND type = $2 AND external_id = $3`,
    [source, type, externalId, requesterPhone, matchId]
  );
}

/** Set when a request can never be fulfilled (e.g. the listing has no contact number on file) — never a live request the buyer is left waiting on. */
export async function markPhotoRequestUnavailable(source: string, type: ListingType, externalId: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE inventory_listings SET photo_request_status = 'unavailable' WHERE source = $1 AND type = $2 AND external_id = $3`,
    [source, type, externalId]
  );
}

/** Appends one received photo to the listing's media array and flips status to 'received' —
 *  safe to call once per inbound image, including every image after the first in a batch. */
export async function appendReceivedPhoto(source: string, type: ListingType, externalId: string, url: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE inventory_listings
     SET requested_photos = requested_photos || $4::jsonb, photo_request_status = 'received'
     WHERE source = $1 AND type = $2 AND external_id = $3`,
    [source, type, externalId, JSON.stringify([{ url, receivedAt: new Date().toISOString() }])]
  );
}

// How long a seller's incoming image is still attributed to an earlier photo request — bounded
// so an unrelated image sent long after a request was made or fulfilled never gets misfiled
// against it.
const PHOTO_REQUEST_LOOKBACK_DAYS = 7;

/**
 * Finds the listing a seller's incoming (non-group) image should be attributed to: the most
 * recent listing whose contact_phone matches theirs and which has an open or just-fulfilled
 * photo request ('requested' or 'received') within the lookback window. 'requested' matches so
 * the very first photo of a reply is still routed; 'received' matches so every photo AFTER the
 * first in the same multi-image reply keeps being forwarded, not just the one that flipped the
 * status.
 */
export async function findPendingPhotoRequestByContactPhone(phone: string): Promise<PhotoRequestRecord | null> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - PHOTO_REQUEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await getPool().query(
    `${PHOTO_REQUEST_SELECT}
     WHERE contact_phone = $1 AND photo_request_status IN ('requested', 'received') AND photo_requested_at > $2
     ORDER BY photo_requested_at DESC LIMIT 1`,
    [phone, cutoff]
  );
  const row = result.rows[0] as PhotoRequestRow | undefined;
  return row ? rowToPhotoRequestRecord(row) : null;
}
