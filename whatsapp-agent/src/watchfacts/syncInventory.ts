import { chromium, Browser } from "playwright";
import { login } from "./scraper";
import { fetchAllFlashSales, isActive, mapToInventoryListing, resolveWtbAuctionType, RawFlashSale } from "./api";
import { upsertListings, markMissingInactive, recordSyncAttempt, recordSyncSuccess, recordSyncError } from "./inventoryDb";

export interface SyncResult {
  forSale: number;
  wtb: number;
  total: number;
}

/** Last write wins on a duplicate id within one fetch — the DB's own dedupe key is source+type+id. */
function dedupeById(sales: RawFlashSale[]): RawFlashSale[] {
  const byId = new Map<string, RawFlashSale>();
  for (const sale of sales) byId.set(sale.id, sale);
  return [...byId.values()];
}

// Shared across the scheduler (index.ts) and the manual /admin/sync-inventory trigger, so
// two overlapping runs can never open two logged-in browser sessions at once.
let syncRunning = false;

/**
 * Logs into WatchFacts once and pulls both sides of the Trading Floor via the real
 * available-flash-sales API (see api.ts) — no DOM scraping, no button clicking. Upserts into
 * the SQLite-backed inventory store and marks anything not seen in this sync inactive, but
 * only for a side (FS or WTB) that returned at least one active listing — a 0-row fetch for
 * one side never touches the other side's data, and never wipes out inventory on its own.
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

    const rawFs = await fetchAllFlashSales(page, "sale");
    const fsListings = dedupeById(rawFs.filter((s) => isActive(s, now))).map((s) => mapToInventoryListing(s, "FS"));

    const wtbAuctionType = await resolveWtbAuctionType(page);
    const rawWtb = await fetchAllFlashSales(page, wtbAuctionType);
    const wtbListings = dedupeById(rawWtb.filter((s) => isActive(s, now))).map((s) => mapToInventoryListing(s, "WTB"));

    const total = fsListings.length + wtbListings.length;
    if (total === 0) {
      throw new Error("Fetched 0 active listings total (FS+WTB) — refusing to mark existing inventory inactive.");
    }

    const syncedAt = now.toISOString();
    if (fsListings.length > 0) {
      await upsertListings(fsListings, syncedAt);
      await markMissingInactive("WF", "FS", fsListings.map((l) => l.id), syncedAt);
    }
    if (wtbListings.length > 0) {
      await upsertListings(wtbListings, syncedAt);
      await markMissingInactive("WF", "WTB", wtbListings.map((l) => l.id), syncedAt);
    }

    await recordSyncSuccess(fsListings.length, wtbListings.length);
    return { forSale: fsListings.length, wtb: wtbListings.length, total };
  } catch (err) {
    await recordSyncError((err as Error).message);
    throw err;
  } finally {
    await browser.close();
    syncRunning = false;
  }
}

if (require.main === module) {
  runInventorySync()
    .then((result) => {
      console.log(`Synced ${result.total} active listings (${result.forSale} FS, ${result.wtb} WTB)`);
    })
    .catch((err) => {
      console.error("WatchFacts inventory sync failed:", err);
      process.exit(1);
    });
}
