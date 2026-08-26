import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";

function resolveCsvPath(): string {
  if (fs.existsSync(config.data.inventoryCsv)) return config.data.inventoryCsv;
  const sample = path.resolve("./data/wf_inventory.sample.csv");
  console.warn(
    `[inventory] ${config.data.inventoryCsv} not found — falling back to sample data at ${sample}. ` +
      `Drop the real WF feed export at data/wf_inventory.csv (see .env INVENTORY_CSV) to use it instead.`
  );
  return sample;
}

let cache: InventoryListing[] | null = null;

export function loadInventory(forceReload = false): InventoryListing[] {
  if (cache && !forceReload) return cache;
  const csvPath = resolveCsvPath();
  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  cache = rows.map((row) => ({
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
    source: row.source || "WF",
    rating: row.rating || "",
    description: row.description || "",
  }));
  return cache;
}

/** Pick up to `count` trending/representative listings to suggest as starter items. */
export function suggestListings(count = 3, category?: string): InventoryListing[] {
  const all = loadInventory();
  const pool = category ? all.filter((l) => l.category === category) : all;
  const source = pool.length >= count ? pool : all;
  // Simple spread: take evenly-spaced items so suggestions vary by category.
  const step = Math.max(1, Math.floor(source.length / count));
  const picks: InventoryListing[] = [];
  for (let i = 0; i < source.length && picks.length < count; i += step) {
    picks.push(source[i]);
  }
  return picks.slice(0, count);
}
