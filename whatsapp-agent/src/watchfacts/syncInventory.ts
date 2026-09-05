import { chromium, Browser, Page } from "playwright";
import { config } from "../config";
import { login } from "./scraper";
import { fetchAllFlashSales, isActive, mapToInventoryListings, resolveListingDetails, resolveWtbAuctionType, RawFlashSale } from "./api";
import { openSourceDb, SourceDb } from "./sourceDb";
import { upsertListings, markMissingInactive, recordSyncAttempt, recordTypeSyncSuccess, recordTypeSyncError, saveAiEnrichment } from "./inventoryDb";
import { enrichAndSplitListings } from "./aiEnrich";
import { ingestApiFsSync } from "../postings/ingest";
import { ApiFsListing } from "../postings/postingsStore";
import { ListingType } from "../types";

export interface SyncResult {
  forSale: number;
  wtb: number;
  total: number;
  fsError?: string;
  wtbError?: string;
  wtbDisabled: boolean;
}

/** Last write wins on a duplicate id within one fetch — the DB's own dedupe key is source+type+id. */
function dedupeById(sales: RawFlashSale[]): RawFlashSale[] {
  const byId = new Map<string, RawFlashSale>();
  for (const sale of sales) byId.set(sale.id, sale);
  return [...byId.values()];
}

interface AuctionRow {
  id: string;
  number: string | number | null; // the site's own public flash-sales/<number> id — see RawFlashSale.publicId
  is_bundle: number;
  title: string | null;
  status: string;
  price: string | number | null;
  deadline: string | Date | null;
  brand: string | null;
  model: string | null;
  reference: string | null;
  normalized_reference: string | null;
  condition_id: number | null;
  front_image: string | null;
  box: string | null;
  papers: string | null;
  dial_color: string | null;
  from_name: string | null;
  from_number: string | null;
  dealer_rating: number | null;
  region: string | null;
}

/**
 * Reads currently-active auctions straight from WatchFacts' own `auctions` table (via
 * sourceDb.ts) instead of the browser-login + paged HTTP API in api.ts. The API has no
 * server-side status filter — a full sync means paging through the ENTIRE historical
 * catalogue (auctions has ~1.5M rows; only ~38k are `status='open'`) — so this is both far
 * cheaper and, since it doesn't depend on a WatchFacts login session staying valid mid-sync,
 * far more reliable. `type` here is the same value api.ts's `auctionType` used ("sale" for FS).
 *
 * Each row maps 1:1 to a single-listing RawFlashSale — this table has no bundle/multi-watch
 * sub-listings structure (unlike the API's nested `listings[]`, used for a dealer's one
 * WhatsApp blast covering several watches), so `isBundle` is always false here and every row
 * becomes exactly one InventoryListing once mapToInventoryListings runs. `condition` is left
 * null rather than mapping the raw `condition_id` FK to a guessed label — nothing here has
 * confirmed what that FK's lookup table/labels actually are, and a wrong label is worse than
 * none for a field that's display-only (see api.ts's mapToInventoryListings). `companyName`/
 * `companyWhatsapp` are similarly left null: those come from a dealer/company join this query
 * doesn't attempt, so contact fields fall through to `from_name`/`from_number`, which this
 * table does have directly, per mapToInventoryListings' own existing fallback chain.
 */
// auctions.front_image is a bare filename (e.g. "6a98d1aa0055a_front_image.jpg"), not a URL —
// confirmed against production: a "Photo:" line built straight from that column 404'd, but this
// exact filename under DigitalOcean Spaces' listings/full/ prefix loaded the real photo. Same
// class of bug as detailUrl/publicId above (an internal storage value used verbatim instead of
// being turned into the real, working link).
function listingImageUrl(frontImage: string | null): string | null {
  if (!frontImage) return null;
  if (/^https?:\/\//i.test(frontImage)) return frontImage; // already a full URL — pass through
  return `https://thecollective-prod.nyc3.digitaloceanspaces.com/listings/full/${frontImage}`;
}

export async function fetchOpenAuctionsFromDb(db: SourceDb, type: string): Promise<RawFlashSale[]> {
  const placeholder = db.dialect === "mysql" ? "?" : "$1";
  const rows = await db.query<AuctionRow>(
    `SELECT id, number, is_bundle, title, status, price, deadline, brand, model, reference,
            normalized_reference, condition_id, front_image, box, papers, dial_color,
            from_name, from_number, dealer_rating, region
       FROM auctions
      WHERE status = 'open' AND type = ${placeholder}`,
    [type]
  );

  return rows.map((row) => ({
    id: row.id,
    publicId: row.number != null ? String(row.number) : undefined,
    isBundle: !!row.is_bundle,
    title: row.title ?? "",
    status: row.status,
    price: row.price != null ? Number(row.price) : 0,
    deadline: row.deadline ? new Date(row.deadline).toISOString() : "",
    listings: [
      {
        id: row.id,
        brand: row.brand,
        model: row.model,
        reference: row.reference,
        normalizedReference: row.normalized_reference,
        title: row.title ?? "",
        condition: null,
        frontImage: listingImageUrl(row.front_image),
        box: row.box,
        papers: row.papers,
        dialColor: row.dial_color,
      },
    ],
    companyName: null,
    fromName: row.from_name,
    companyStars: row.dealer_rating != null ? Number(row.dealer_rating) : null,
    whatsappNumber: row.from_number,
    companyWhatsapp: null,
    region: row.region,
  }));
}

/**
 * Everything after "we now have this side's raw sales" — filtering to active, deduping,
 * mapping, AI enrichment, the upsert, and (FS only) the v4 postings mirror/reverse-match.
 * Shared by both fetch paths (browser API and direct-DB) so which one supplied `raw` never
 * changes what happens to it downstream. Records its own success/failure in sync_meta;
 * callers that also wrap the fetch itself in a try/catch (syncOneSide) only need to handle
 * the fetch failing, since a failure in here is already recorded before it's returned.
 */
async function processRawSales(raw: RawFlashSale[], type: ListingType, now: Date): Promise<{ count: number; error?: string }> {
  try {
    const dedupedRaw = dedupeById(raw.filter((s) => isActive(s, now)));
    // Each sale's structured sub-listings are mapped individually (a bundle lot of several
    // watches becomes several InventoryListings, not just its first one) — see
    // mapToInventoryListings.
    const mapped = dedupedRaw.flatMap((s) => mapToInventoryListings(s, type));
    // AI enrichment/splitting (ENABLE_AI_MATCHING) — a no-op pass-through when disabled. Only
    // ever touches an unstructured multi-watch blast that the deterministic mapper above
    // couldn't already break apart; never runs for content unchanged since the last sync.
    const { rows: listings, toSave } = await enrichAndSplitListings(mapped);

    if (listings.length > 0) {
      const syncedAt = now.toISOString();
      await upsertListings(listings, syncedAt);
      await markMissingInactive("WF", type, listings.map((l) => l.id), syncedAt);
      for (const item of toSave) {
        await saveAiEnrichment("WF", item.type, item.externalId, item.hash, item.enrichment);
      }
    }

    // Fi Build Spec v4: mirrors FS into the `postings` table and reverse-matches any new or
    // materially-changed listing against active chat-originated WTB monitors (see
    // ingestApiFsSync / src/postings/matching.ts) — the same matching engine chat ingestion
    // uses, not a second one. Gated behind ENABLE_V4_POSTINGS (off by default) until its
    // migrations/tests/notification behavior are verified; never blocks or fails the
    // existing, already-tested inventory_listings write above if this additive step errors.
    if (type === "FS" && config.postingsV4.enabled) {
      try {
        // Recomputed per-sale (rather than reusing the flattened `listings` above) so each
        // sub-listing can be zipped back to its own frontImage via resolveListingDetails'
        // guaranteed matching order/length.
        const apiFsListings: ApiFsListing[] = dedupedRaw.flatMap((s) => {
          const subListings = mapToInventoryListings(s, "FS");
          const images = resolveListingDetails(s).map((d) => d?.frontImage ?? null);
          return subListings.map((l, i) => ({
            id: l.id,
            item: l.item,
            brand: l.brand,
            ref: l.ref,
            condition: l.condition,
            price: l.price,
            location: l.location,
            dial: l.dial,
            model: l.model,
            boxPapers: l.boxPapers,
            contactName: l.contactName,
            contactPhone: l.contactPhone,
            detailUrl: l.detailUrl,
            description: l.description,
            imageUrl: images[i] ?? null,
          }));
        });
        await ingestApiFsSync(apiFsListings);
      } catch (err) {
        console.error("[watchfacts] postings mirror/reverse-match failed (inventory_listings sync itself succeeded):", err);
      }
    }

    await recordTypeSyncSuccess(type);
    return { count: listings.length };
  } catch (err) {
    const message = (err as Error).message;
    await recordTypeSyncError(type, message);
    return { count: 0, error: message };
  }
}

/**
 * Fetches, filters, dedupes, and upserts one side (FS or WTB) of the Trading Floor via the
 * browser-login + HTTP API path (api.ts). Errors are caught and recorded here rather than
 * propagated, so a WTB failure (e.g. its auction_type can't be resolved) never prevents FS's
 * own results from being saved, and vice versa — each side's success/failure is tracked
 * independently in sync_meta.
 */
export async function syncOneSide(
  page: Page,
  type: ListingType,
  auctionType: string | (() => Promise<string>),
  now: Date
): Promise<{ count: number; error?: string }> {
  try {
    const resolvedAuctionType = typeof auctionType === "string" ? auctionType : await auctionType();
    const raw = await fetchAllFlashSales(page, resolvedAuctionType);
    return await processRawSales(raw, type, now);
  } catch (err) {
    const message = (err as Error).message;
    await recordTypeSyncError(type, message);
    return { count: 0, error: message };
  }
}

/** FS via direct database access (see fetchOpenAuctionsFromDb) — no browser, no login, no paging. */
async function syncFsFromDb(db: SourceDb, now: Date): Promise<{ count: number; error?: string }> {
  try {
    const raw = await fetchOpenAuctionsFromDb(db, "sale");
    return await processRawSales(raw, "FS", now);
  } catch (err) {
    const message = (err as Error).message;
    await recordTypeSyncError("FS", message);
    return { count: 0, error: message };
  }
}

// Shared across the scheduler (index.ts) and the manual /admin/sync-inventory trigger, so
// two overlapping runs can never open two logged-in browser sessions (or two DB syncs) at once.
let syncRunning = false;

/**
 * Pulls both sides of the Trading Floor. FS is read directly from WatchFacts' own database
 * when WATCHFACTS_DB_URL is configured (see fetchOpenAuctionsFromDb) — no browser, no login,
 * no pagination through a 1.5M-row historical catalogue. Without it, FS falls back to the
 * original browser-login + HTTP API path, same as WTB always uses (WTB's auction_type isn't
 * confirmed against a DB column yet, and it's off by default regardless). FS and WTB are
 * synced independently (see processRawSales): one side failing never touches the other side's
 * data or masks that it succeeded. Only throws if BOTH sides fail outright.
 */
export async function runInventorySync(): Promise<SyncResult> {
  if (syncRunning) {
    throw new Error("a sync is already running");
  }
  syncRunning = true;
  await recordSyncAttempt();

  const useDbForFs = !!config.watchfacts.sourceDbUrl;
  const wtbEnabled = config.watchfacts.enableWtbSync;

  let db: SourceDb | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  async function ensureBrowserLoggedIn(): Promise<Page> {
    if (!page) {
      browser = await chromium.launch();
      page = await browser.newPage();
      await login(page);
    }
    return page;
  }

  try {
    const now = new Date();

    let fs: { count: number; error?: string };
    if (useDbForFs) {
      db = await openSourceDb();
      fs = await syncFsFromDb(db, now);
    } else {
      fs = await syncOneSide(await ensureBrowserLoggedIn(), "FS", "sale", now);
    }

    // When disabled, WTB is never fetched at all: no request, no error recorded, nothing touched.
    const wtb = wtbEnabled
      ? await syncOneSide(await ensureBrowserLoggedIn(), "WTB", () => resolveWtbAuctionType(page!), now)
      : { count: 0 };

    if (fs.error && wtbEnabled && wtb.error) {
      throw new Error(`Both FS and WTB failed — FS: ${fs.error} | WTB: ${wtb.error}`);
    }
    if (fs.error && !wtbEnabled) {
      throw new Error(`FS failed and WTB sync is disabled (ENABLE_WTB_SYNC=false) — FS: ${fs.error}`);
    }

    return {
      forSale: fs.count,
      wtb: wtb.count,
      total: fs.count + wtb.count,
      fsError: fs.error,
      wtbError: wtbEnabled ? wtb.error : undefined,
      wtbDisabled: !wtbEnabled,
    };
  } finally {
    await db?.close().catch(() => undefined);
    await browser?.close();
    syncRunning = false;
  }
}

if (require.main === module) {
  runInventorySync()
    .then((result) => {
      console.log(
        `Synced ${result.total} active listings (${result.forSale} FS, ${result.wtb} WTB)` +
          (result.fsError ? ` — FS error: ${result.fsError}` : "") +
          (result.wtbDisabled ? ` — WTB disabled (ENABLE_WTB_SYNC=false)` : "") +
          (result.wtbError ? ` — WTB error: ${result.wtbError}` : "")
      );
    })
    .catch((err) => {
      console.error("WatchFacts inventory sync failed:", err);
      process.exit(1);
    });
}
