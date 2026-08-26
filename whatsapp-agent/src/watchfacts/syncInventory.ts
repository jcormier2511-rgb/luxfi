import fs from "fs";
import path from "path";
import { config } from "../config";
import { InventoryListing } from "../types";
import { openWatchFactsSession } from "./scraper";

const COLUMNS: (keyof InventoryListing)[] = [
  "id",
  "type",
  "category",
  "item",
  "brand",
  "ref",
  "condition",
  "price",
  "location",
  "contactName",
  "contactPhone",
  "source",
  "rating",
  "description",
];
const HEADER = ["id", "type", "category", "item", "brand", "ref", "condition", "price", "location", "contact_name", "contact_phone", "source", "rating", "description"];

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(rows: InventoryListing[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => csvEscape(String(row[c] ?? ""))).join(","));
  }
  return lines.join("\n") + "\n";
}

export interface SyncResult {
  forSale: number;
  wtb: number;
  total: number;
}

/**
 * Logs into WatchFacts, pulls both sides of the Trading Floor feed, and overwrites
 * wf_inventory.csv with the result. Called by the CLI script below and by
 * POST /admin/sync-inventory — run it on a schedule (an external cron hitting that
 * endpoint, or a Railway scheduled job) wherever it can actually reach watchfacts.com.
 * Refuses to overwrite the file if the fetch comes back empty, so a transient scrape
 * failure can't silently wipe out good data.
 */
export async function runInventorySync(): Promise<SyncResult> {
  const session = await openWatchFactsSession();
  try {
    // Sequential, not Promise.all: both calls navigate the same underlying browser tab,
    // so running them concurrently races two page.goto()s against each other and produces
    // garbage results (this is exactly what caused an earlier 0-vs-20 FS/WTB split).
    const forSale = await session.fetchTradingListings("FS");
    const wtb = await session.fetchTradingListings("WTB");
    const rows = [...forSale, ...wtb];
    if (rows.length === 0) {
      throw new Error("Fetched 0 listings total — refusing to overwrite wf_inventory.csv with an empty file.");
    }
    fs.mkdirSync(path.dirname(config.data.inventoryCsv), { recursive: true });
    fs.writeFileSync(config.data.inventoryCsv, toCsv(rows));
    return { forSale: forSale.length, wtb: wtb.length, total: rows.length };
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  runInventorySync()
    .then((result) => {
      console.log(`Wrote ${result.total} listings (${result.forSale} FS, ${result.wtb} WTB) to ${config.data.inventoryCsv}`);
    })
    .catch((err) => {
      console.error("WatchFacts inventory sync failed:", err);
      process.exit(1);
    });
}
