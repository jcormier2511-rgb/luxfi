import fs from "fs";
import path from "path";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";
import { ingestAndMatch } from "../postings/ingest";
import { normalizeText, classifyText } from "../postings/normalize";
import { enrichListingText } from "../ai/enrichment";
import { isPostingMonitoringEnabled } from "../admin/store";

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
 * Builds the row(s) to record for one captured group message. When AI inventory enrichment is
 * enabled (ENABLE_AI_INVENTORY_ENRICHMENT — independent of ENABLE_AI_MATCHING, see config.ts),
 * an unstructured multi-watch price-list dump is split into one row per watch AI found real
 * evidence for in the text; otherwise (and always when it's off, unset, or finds at most one
 * watch) this is exactly the original single-row deterministic behavior via normalizeText. A
 * message is only ever processed once (see alreadyProcessed in server.ts), so there's no
 * separate content-hash cache needed here the way the WatchFacts sync path has one.
 */
async function buildGroupRows(
  groupId: string,
  senderPhone: string,
  senderName: string | undefined,
  type: ListingType,
  text: string
): Promise<InventoryListing[]> {
  if (config.aiMatching.enrichmentEnabled) {
    const enrichment = await enrichListingText(text);
    if (enrichment.length > 1) {
      return enrichment.map((e, i) => ({
        id: `group-${groupId}-${Date.now()}-${i}`,
        type,
        category: "watches",
        item: e.evidence,
        brand: e.brand || "",
        ref: e.referenceRaw || e.referenceFamily || "",
        condition: e.condition || "",
        price: e.price != null ? `${e.currency || "USD"} ${e.price}` : "ASK",
        location: e.location || "",
        contactName: senderName || senderPhone,
        contactPhone: senderPhone,
        source: "WA-Group",
        rating: "",
        description: e.evidence,
      }));
    }
  }

  // Shared with the v4 chat-ingestion path (postingsStore.ts) — brand/reference extraction,
  // and price validation that returns null (never a guess) when the message names more than
  // one distinct $ amount, e.g. a multi-item dealer price-list dump. Without this, a huge
  // group post could get an arbitrary price attributed to it and, since it previously never
  // extracted brand/ref at all, could never be reference-filtered out of an unrelated search.
  const normalized = normalizeText(text);
  return [
    {
      id: `group-${groupId}-${Date.now()}`,
      type,
      category: "watches",
      item: text.slice(0, 120),
      brand: normalized.brand,
      ref: normalized.reference,
      condition: "",
      price: normalized.price !== null ? `${normalized.currency} ${normalized.price}` : "ASK",
      location: "",
      contactName: senderName || senderPhone,
      contactPhone: senderPhone,
      source: "WA-Group",
      rating: "",
      description: text,
    },
  ];
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
  // Dealer-group jargon, distinct from the 1:1 flow's classify() (which expects first-person
  // phrasing like "buy: X"). Shares the same rule as v4's structured ingestion (postings/
  // normalize.ts) so a group post is never classified one way for the legacy CSV capture below
  // and a different way for the v4 dual-write path — one rule, not two hand-synced copies.
  const type: ListingType | null = classifyText(text);
  if (!type) return;

  const rows = await buildGroupRows(groupId, senderPhone, senderName, type, text);
  rows.forEach(appendGroupListing);
  console.log(
    `[group-monitor] captured ${type} post from ${senderPhone} in group ${groupId} as ${rows.length} row(s): "${text.slice(0, 60)}"`
  );

  // Gated on BOTH the master flag AND this specific group being explicitly allowlisted (spec:
  // controlled test-group rollout) — see config.postingsV4 / ENABLE_V4_POSTINGS /
  // V4_ALLOWED_CHAT_IDS. Since nothing from a non-allowed group ever reaches ingestChatPosting,
  // it can never appear as a matching candidate, get notified about, or be approved/passed
  // either — the same gate covers ingestion, notification, and decision handling consistently.
  // appendGroupListing above (the existing v3 CSV capture) is unaffected either way, and never
  // sends a message itself, so this gate can never cause a duplicate ack/match card/intro.
  // PostgreSQL is authoritative once any approved-group record exists. The env list remains a
  // migration fallback only; its historical "*" value is never accepted in production.
  const allowed = await isPostingMonitoringEnabled({ source_type: "chat", source_chat_id: groupId });
  if (!allowed) return;

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
