import fs from "fs";
import path from "path";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";
import { loadInventory } from "../data/inventoryStore";

// Dealer-group shorthand, distinct from the 1:1 flow's classify() (which expects
// first-person phrasing like "buy: X"). Groups post in trading-floor jargon instead.
const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of)\b/i;
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling)\b/i;
const PRICE_PATTERN = /\$\s?[\d,]+(?:\.\d+)?/;

function classifyGroupPost(text: string): ListingType | null {
  if (FS_KEYWORDS.test(text)) return "FS";
  if (WTB_KEYWORDS.test(text)) return "WTB";
  return null;
}

const GROUP_LISTINGS_HEADER =
  "id,type,category,item,brand,ref,condition,price,location,contact_name,contact_phone,source,rating,description\n";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function appendGroupListing(row: InventoryListing): void {
  const csvPath = config.data.groupListingsCsv;
  const line =
    [
      row.id,
      row.type,
      row.category,
      row.item,
      row.brand,
      row.ref,
      row.condition,
      row.price,
      row.location,
      row.contactName,
      row.contactPhone,
      row.source,
      row.rating,
      row.description,
    ]
      .map((v) => csvEscape(String(v ?? "")))
      .join(",") + "\n";

  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, GROUP_LISTINGS_HEADER + line);
  } else {
    fs.appendFileSync(csvPath, line);
  }
  loadInventory(true); // pick up the new row immediately, no restart needed
}

/**
 * Silently parses a WhatsApp group message for a WTB/FS-style post and, if it looks like
 * one, appends it to the matching engine's inventory. Never sends a reply — group monitoring
 * is read-only by design (matches the "Fi never posts, only reads" promise on the landing
 * page). Not yet validated against a real dealer group; add one this channel's WhatsApp
 * number is a participant of and watch the logs / GET /admin/group-listings to confirm posts
 * are actually being captured and classified correctly.
 */
export function handleGroupMessage(groupId: string, senderPhone: string, senderName: string | undefined, text: string): void {
  const type = classifyGroupPost(text);
  if (!type) return;

  const priceMatch = text.match(PRICE_PATTERN);
  const row: InventoryListing = {
    id: `group-${groupId}-${Date.now()}`,
    type,
    category: "watches",
    item: text.slice(0, 120),
    brand: "",
    ref: "",
    condition: "",
    price: priceMatch ? priceMatch[0].replace(/[$\s]/g, "") : "ASK",
    location: "",
    contactName: senderName || senderPhone,
    contactPhone: senderPhone,
    source: "WA-Group",
    rating: "",
    description: text,
  };

  appendGroupListing(row);
  console.log(`[group-monitor] captured ${type} post from ${senderPhone} in group ${groupId}: "${text.slice(0, 60)}"`);
}
