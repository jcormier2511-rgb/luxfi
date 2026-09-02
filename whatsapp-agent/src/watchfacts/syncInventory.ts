import { chromium, Browser, Page } from "playwright";
import { config } from "../config";
import { login } from "./scraper";
import { fetchAllFlashSales, isActive, mapToInventoryListings, resolveListingDetails, resolveWtbAuctionType, RawFlashSale } from "./api";
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

/**
 * Fetches, filters, dedupes, and upserts one side (FS or WTB) of the Trading Floor. Errors
 * are caught and recorded here rather than propagated, so a WTB failure (e.g. its
 * auction_type can't be resolved) never prevents FS's own results from being saved, and
 * vice versa — each side's success/failure is tracked independently in sync_meta.
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

// Shared across the scheduler (index.ts) and the manual /admin/sync-inventory trigger, so
// two overlapping runs can never open two logged-in browser sessions at once.
let syncRunning = false;

/**
 * Logs into WatchFacts once and pulls both sides of the Trading Floor via the real
 * available-flash-sales API (see api.ts) — no DOM scraping, no button clicking. FS and WTB
 * are synced independently (see syncOneSide): one side failing never touches the other
 * side's data or masks that it succeeded. Only throws if BOTH sides fail outright.
 */
export async function runInventorySync(): Promise<SyncResult> {
  if (syncRunning) {
    throw new Error("a sync is already running");
  }
  syncRunning = true;
  await recordSyncAttempt();
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await login(page);
    const now = new Date();

    const fs = await syncOneSide(page, "FS", "sale", now);

    // WTB's auction_type isn't confirmed against the real API — off by default. When
    // disabled, WTB is never fetched at all: no request, no error recorded, nothing touched.
    const wtbEnabled = config.watchfacts.enableWtbSync;
    const wtb = wtbEnabled ? await syncOneSide(page, "WTB", () => resolveWtbAuctionType(page), now) : { count: 0 };

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
    await browser.close();
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
