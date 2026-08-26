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

function parseInventoryCsv(csvPath: string): InventoryListing[] {
  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return rows.map((row) => ({
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
}

let cache: InventoryListing[] | null = null;

export function loadInventory(forceReload = false): InventoryListing[] {
  if (cache && !forceReload) return cache;
  const main = parseInventoryCsv(resolveCsvPath());
  // Kept in a separate file on purpose (see config.data.groupListingsCsv) so a WatchFacts
  // sync's wholesale overwrite of the main CSV never wipes out group-captured listings.
  const groupPosts = fs.existsSync(config.data.groupListingsCsv) ? parseInventoryCsv(config.data.groupListingsCsv) : [];
  cache = [...main, ...groupPosts];
  return cache;
}
