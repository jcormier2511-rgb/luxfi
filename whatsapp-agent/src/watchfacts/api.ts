import { Page } from "playwright";
import { InventoryListing, ListingType } from "../types";

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
}

const CATEGORY_ID_WATCHES = 19;
const PAGE_SIZE = 25;
// Safety valve, not an expected ceiling — stops a pagination bug (or a field-name change in
// WatchFacts' response envelope that breaks the "last page" check) from looping forever.
const MAX_PAGES = 50;

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

/** Pure mapping, independent of network/DOM — the part requirement #10's tests exercise directly. */
export function mapToInventoryListing(sale: RawFlashSale, type: ListingType): InventoryListing {
  const detail = sale.listings?.[0];
  return {
    id: sale.id,
    type,
    category: "watches",
    item: sale.title ?? "",
    brand: detail?.brand ?? "",
    ref: detail?.reference ?? detail?.normalizedReference ?? "",
    condition: detail?.condition ?? "",
    price: sale.price > 0 ? String(sale.price) : "ASK",
    location: sale.region ?? "",
    contactName: sale.companyName || sale.fromName || "",
    contactPhone: sale.whatsappNumber || sale.companyWhatsapp || "",
    source: "WF",
    rating: sale.companyStars != null ? String(sale.companyStars) : "",
    description: sale.title ?? "",
  };
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

/** Pages through `available-flash-sales` until a short page (or empty page) signals the end. */
export async function fetchAllFlashSales(page: Page, auctionType: string): Promise<RawFlashSale[]> {
  const all: RawFlashSale[] = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const batch = await fetchFlashSalesPage(page, auctionType, p);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break; // last page
  }
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
