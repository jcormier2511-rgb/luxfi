import { chromium, Browser, Page } from "playwright";
import { config } from "../config";
import { login } from "./scraper";
import { fetchAllFlashSales, isActive, mapToInventoryListing, resolveWtbAuctionType, RawFlashSale } from "./api";
import { upsertListings, markMissingInactive, recordSyncAttempt, recordTypeSyncSuccess, recordTypeSyncError } from "./inventoryDb";
import { mirrorApiFsPosting, markApiPostingsInactive } from "../postings/postingsStore";
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
    const listings = dedupeById(raw.filter((s) => isActive(s, now))).map((s) => mapToInventoryListing(s, type));

    if (listings.length > 0) {
      const syncedAt = now.toISOString();
      await upsertListings(listings, syncedAt);
      await markMissingInactive("WF", type, listings.map((l) => l.id), syncedAt);
    }

    // Mirrors FS only into the new Fi Build Spec v4 `postings` table so automatic matching has
    // a live source (see src/postings/matching.ts) — never blocks or fails the existing,
    // already-tested inventory_listings write above if this additive step has a problem.
    if (type === "FS") {
      try {
        for (const listing of listings) {
          await mirrorApiFsPosting(listing);
        }
        await markApiPostingsInactive(listings.map((l) => l.id));
      } catch (err) {
        console.error("[watchfacts] postings mirror failed (inventory_listings sync itself succeeded):", err);
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
