import type { Page } from "playwright";
import { InventoryListing, ListingType } from "../types";
import { extractReference, extractUnambiguousPrice, classifyTextKeyword } from "../postings/normalize";
import { extractNativePrice } from "../fx/currency";
import { config } from "../config";

/**
 * Real WatchFacts Trading Floor API, found by capturing network traffic from a logged-in
 * session (see the `available-flash-sales` request the site's own page makes). Confirmed
 * live: requires a valid session cookie (a plain unauthenticated request returns
 * {"message":"session_expired"}), so every call here must run inside an already-logged-in
 * Playwright page via `page.evaluate(() => fetch(...))` rather than a standalone HTTP client
 * — that's the only way to carry the browser's session cookie automatically.
 */

export interface RawListingDetail {
  id: string;
  brand: string | null;
  model: string | null;
  reference: string | null;
  normalizedReference: string | null;
  title: string;
  condition: string | null;
  frontImage: string | null;
  box: string | null;
  papers: string | null;
  dialColor: string | null;
}

export interface RawFlashSale {
  id: string;
  isBundle: boolean;
  title: string;
  status: string; // "open" when live; anything else treated as closed/expired
  price: number; // 0 observed for some bulk-lot listings whose real price is only in `title`
  deadline: string; // e.g. "2026-09-01 15:41:16" — flash sale expiry
  listings: RawListingDetail[];
  companyName: string | null;
  fromName: string | null;
  companyStars: number | null;
  whatsappNumber: string | null;
  companyWhatsapp: string | null;
  region: string | null;
  // The site's own public flash-sales URL is keyed on `auctions.number` (a short integer),
  // NOT this object's own `id` (that table's UUID primary key) — confirmed by a 500 on every
  // link built from `id` and a real listing loading correctly at .../flash-sales/<number>.
  // Only the direct-DB sync path (syncInventory.ts's fetchOpenAuctionsFromDb) currently
  // populates this; when absent, mapToInventoryListings falls back to `id` unchanged.
  publicId?: string;
}

const CATEGORY_ID_WATCHES = 19;
const PAGE_SIZE = 25;

const WTB_AUCTION_TYPE_CANDIDATES = [
  "wtb",
  "buy",
  "want_to_buy",
  "want-to-buy",
  "ntq",
  "purchase",
  "request",
  "looking_to_buy",
  "ltb",
  "buying",
];

/** True only for listings that are both marked open AND not past their own deadline. */
export function isActive(sale: Pick<RawFlashSale, "status" | "deadline">, now: Date = new Date()): boolean {
  if (sale.status !== "open") return false;
  const deadline = new Date(sale.deadline);
  if (Number.isNaN(deadline.getTime())) return true; // don't reject on our own parsing failure
  return deadline > now;
}

/**
 * A flash sale's `listings` array holds every structured sub-listing (a "bundle" lot can have
 * several distinct watches under one sale). Falls back to a single `undefined` placeholder
 * when there are none, so callers always get at least one entry with empty detail fields —
 * the same behavior a sale with no listings had before. Exported so syncInventory.ts can zip
 * its own per-listing data (e.g. images) against the exact same ordering without duplicating
 * this fallback logic.
 */
export function resolveListingDetails(sale: RawFlashSale): (RawListingDetail | undefined)[] {
  return sale.listings && sale.listings.length > 0 ? sale.listings : [undefined];
}

/**
 * Pure mapping, independent of network/DOM — the part requirement #10's tests exercise
 * directly. Maps EVERY structured sub-listing in a sale individually rather than only the
 * bundle's first watch, so a lot of several different watches becomes several distinct
 * InventoryListings.
 *
 * Each sub-listing's id is `${sale.id}-${detail.id}` — keyed on WatchFacts' OWN sub-listing
 * id, never on its array position. upsertListings/markMissingInactive key on this id, so a
 * positional id would silently reassign one watch's identity to whatever happens to occupy
 * the same array slot on the next sync (if WatchFacts reorders or removes an item from the
 * middle of a bundle) — overwriting or losing data rather than just skipping/adding a row.
 * detail.id is the one thing that's actually stable across syncs for the same physical watch.
 *
 * A bundle's `sale.price` is a single total for the whole lot — attributing that figure to
 * each individual sub-listing would misrepresent its actual price, so a multi-listing sale
 * uses "ASK" per item instead; a single-listing sale keeps the confirmed top-level price,
 * unless the listing's own title names a different, unambiguous price of its own (see below).
 */
export function mapToInventoryListings(sale: RawFlashSale, type: ListingType): InventoryListing[] {
  const details = resolveListingDetails(sale);
  const isBundleOfMultiple = details.length > 1;

  return details.map((detail, i) => {
    // Prefer the individual sub-listing's own title over the parent sale's — the sale title is
    // the whole dealer blast/bundle headline, which is exactly the "generic bundle" text that
    // must never stand in for one specific watch's description.
    const title = detail?.title || sale.title || "";
    // WatchFacts doesn't always populate a sub-listing's structured reference field — when it's
    // missing, extract one from THAT sub-listing's own title only, never from the parent sale's
    // (bundle-wide) text, which could contain several other watches' reference numbers.
    const ref = detail?.reference || detail?.normalizedReference || extractReference(title) || "";
    // Real reported bug: a single-listing sale's structured sale.price field disagreed wildly
    // with the price the dealer actually typed into the title ("$2" vs. the title's own
    // "105.000 USD"). When the title itself names one unambiguous price, that specific,
    // human-typed figure for THIS watch is trusted over the structured field — the structured
    // field is used only as a fallback when the title has no price of its own to check against.
    // Never attempted for a bundle item — sale.price there is the whole lot's total, and a
    // sub-listing's own title price (if any) isn't cross-checked against anything reliable.
    const textPrice = !isBundleOfMultiple ? extractUnambiguousPrice(title) : null;
    const price = isBundleOfMultiple ? "ASK" : textPrice !== null ? String(textPrice) : sale.price > 0 ? String(sale.price) : "ASK";
    // Automatic currency conversion (src/fx/) — the listing's OWN currency, read the same way
    // as the title-price override above, from that sub-listing's own title only (never the
    // bundle-wide sale title, which could name several other watches' prices/currencies).
    // Independent of the bundle-vs-single price decision above: even a bundle sub-listing's own
    // title can state its currency, purely as descriptive info about what the text says — this
    // never feeds into the "ASK" bundle-price safety rule, only into currency-aware display/
    // budget comparison for whichever price ends up being used.
    const native = extractNativePrice(title);
    // WatchFacts reports box/papers as two separate yes/no-ish fields — combined into one
    // free-text value here since nothing downstream matches on box/papers structurally, only
    // displays it (see postings/postingsStore.ts's boxPapers, matching.ts's scoreMatch which
    // never gates on it).
    const boxPapers =
      [detail?.box ? `Box: ${detail.box}` : null, detail?.papers ? `Papers: ${detail.papers}` : null]
        .filter((v): v is string => v !== null)
        .join(", ") || undefined;
    // Real reported bug: WatchFacts' own site listed several dealer posts titled "WTB
    // 116500LN...", "LOOKING TO BUY...", "Ntq 116500ln..." under its "sale" listing type — the
    // structured `type` this function is called with (from auctions.type) isn't always right,
    // and trusting it blindly would count a BUYER's budget as a SELLER's ask, corrupting every
    // downstream FS pricing statistic (Market Guide/Market Pulse). classifyTextKeyword's WTB/FS
    // keyword check on the listing's own title is the same deterministic classifier chat-ingested
    // postings already trust for exactly this judgment — reused here as a cross-check, not a
    // second, independently-tuned classifier. Keyword-only (never classifyText's bare-price-
    // implies-FS fallback), so a real WTB post that states a budget but no WTB keyword can never
    // get flipped the other way by this override.
    const effectiveType: ListingType = classifyTextKeyword(title) ?? type;
    return {
      id: isBundleOfMultiple ? `${sale.id}-${detail?.id ?? i}` : sale.id,
      type: effectiveType,
      category: "watches",
      item: title,
      brand: detail?.brand ?? "",
      ref,
      condition: detail?.condition ?? "",
      price,
      location: sale.region ?? "",
      contactName: sale.companyName || sale.fromName || "",
      contactPhone: sale.whatsappNumber || sale.companyWhatsapp || "",
      source: "WF",
      rating: sale.companyStars != null ? String(sale.companyStars) : "",
      description: title,
      detailUrl: `https://watchfacts.com/flash-sales/${sale.publicId ?? sale.id}`,
      imageUrl: detail?.frontImage || undefined,
      nativePriceAmount: native?.amount,
      nativeCurrency: native?.currency,
      originalPriceText: native?.originalText,
      dial: detail?.dialColor ?? undefined,
      model: detail?.model ?? undefined,
      boxPapers,
    };
  });
}

async function fetchFlashSalesPage(page: Page, auctionType: string, pageNum: number): Promise<RawFlashSale[]> {
  const url =
    `https://watchfacts.com/available-flash-sales?pageSize=${PAGE_SIZE}&page=${pageNum}` +
    `&auction_type=${encodeURIComponent(auctionType)}&category_id=${CATEGORY_ID_WATCHES}&sort_by=date-newest`;

  // Runs inside the page so the browser's own session cookie is attached automatically —
  // this endpoint 401s (session_expired) on any request that doesn't carry it.
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${u}`);
    const body = await res.json();
    // Defensive: the exact response envelope (raw array vs {data:[...]}) wasn't confirmed
    // from the captured sample alone, so accept either shape rather than assume one.
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.data)) return body.data;
    if (Array.isArray(body?.listings)) return body.listings;
    throw new Error(`Unexpected response shape from ${u}: ${JSON.stringify(body).slice(0, 200)}`);
  }, url);
}

/**
 * Pages until a short (or empty) page signals the end.
 *
 * The page ceiling is a safety valve against a paging bug or a response-envelope change that
 * breaks the last-page check — never an expected stopping point, so it is sized for a full
 * catalogue (config.watchfacts.maxSyncPages) rather than the flash-sale pool. It used to be 50,
 * which at 25 rows a page silently truncated anything past 1,250 listings; hitting it now logs
 * loudly, because a sync that stops early is worse than one that fails.
 */
export async function fetchAllFlashSales(page: Page, auctionType: string): Promise<RawFlashSale[]> {
  const all: RawFlashSale[] = [];
  const maxPages = config.watchfacts.maxSyncPages;
  for (let p = 1; p <= maxPages; p++) {
    const batch = await fetchFlashSalesPage(page, auctionType, p);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all; // last page
    // Long syncs are otherwise silent for however many minutes they take.
    if (p % 100 === 0) console.log(`[watchfacts] ${auctionType}: fetched ${all.length} listings (page ${p})`);
  }
  console.warn(`[watchfacts] ${auctionType}: stopped at the ${maxPages}-page ceiling with ${all.length} listings — the catalogue is probably TRUNCATED. Raise WATCHFACTS_MAX_SYNC_PAGES.`);
  return all;
}

/**
 * The site's "NTQ/WTB" toggle isn't a real clickable element Playwright can reliably hit, so
 * instead of depending on it, this tries `auction_type` values directly against the real API
 * (already proven to accept `auction_type=sale` for FS) and returns the first one that comes
 * back with actual rows. Stops at the first success — one request per candidate at most.
 */
export async function resolveWtbAuctionType(page: Page): Promise<string> {
  for (const candidate of WTB_AUCTION_TYPE_CANDIDATES) {
    try {
      const batch = await fetchFlashSalesPage(page, candidate, 1);
      if (batch.length > 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Could not find a working auction_type value for WTB — tried: ${WTB_AUCTION_TYPE_CANDIDATES.join(", ")}`);
}
