import fs from "fs";
import path from "path";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";
import { ingestAndMatch } from "../postings/ingest";

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
  // No cache to invalidate — getActiveListings() reads this CSV fresh on every call.
}

/**
 * Silently parses a WhatsApp group message for a WTB/FS-style post. Never sends a reply into
 * the group — group monitoring is read-only by design (matches the "Fi never posts, only
 * reads" promise on the landing page). Not yet validated against a real dealer group; add one
 * this channel's WhatsApp number is a participant of and watch the logs / GET
 * /admin/group-listings to confirm posts are actually being captured and classified correctly.
 *
 * Dual-writes on purpose: the CSV path (via appendGroupListing, below) keeps feeding the
 * existing v3 on-demand search flow unchanged; `ingestAndMatch` is the new Fi Build Spec v4
 * automatic-monitoring path (Postgres `postings`, idempotent by messageId, immediate
 * bidirectional matching, private notifications). Postgres is the authoritative store for
 * the new system — the CSV is not.
 */
export async function handleGroupMessage(
  messageId: string,
  groupId: string,
  senderPhone: string,
  senderName: string | undefined,
  text: string,
  imageUrl?: string
): Promise<void> {
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

  // Gated: the v4 automatic monitoring/matching path (postings ingestion + notifications)
  // stays off in production until its migrations, integration tests, and notification
  // behavior are verified — see config.postingsV4 / ENABLE_V4_POSTINGS. appendGroupListing
  // above (the existing v3 CSV capture) is unaffected either way, and never sends a message
  // itself, so this flag can never cause a duplicate acknowledgment/match card/introduction.
  if (!config.postingsV4.enabled) return;

  try {
    await ingestAndMatch({
      platform: "whatsapp",
      chatId: groupId,
      messageId,
      senderIdentity: senderPhone,
      senderName,
      text,
      imageUrl,
    });
  } catch (err) {
    console.error(`[group-monitor] postings ingestion/matching failed for message ${messageId}:`, err);
  }
}
