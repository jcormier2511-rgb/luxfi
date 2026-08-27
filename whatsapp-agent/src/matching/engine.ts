import { getActiveListings } from "../watchfacts/inventoryDb";
import { InventoryListing, ItemRequest, SearchPreferences } from "../types";
import { normalizeReference, extractReference, referencesMatch } from "../postings/normalize";

// Shares extractReference/REFERENCE_PATTERN with postings/normalize.ts (v4) — one reference-
// extraction rule for both, not two hand-synced copies. A reference number in the free-text
// query (e.g. "buy: Rolex Daytona 116500LN") is a hard filter, not a keyword blended into
// token scoring; extractReference already excludes a $-prefixed amount ("under $20000") from
// being mistaken for one.
function extractRequestedReference(query: string): string | null {
  const ref = extractReference(query);
  return ref ? normalizeReference(ref) : null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function score(listing: InventoryListing, tokens: string[]): number {
  const haystack = tokenize(`${listing.brand} ${listing.item} ${listing.ref} ${listing.category} ${listing.description}`);
  let matches = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) matches += 1;
  }
  return matches;
}

function parseListingPrice(raw: string): number | undefined {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** True if a listing's price falls inside the preference range, or no range was set. */
function inPriceRange(listing: InventoryListing, preferences?: SearchPreferences): boolean {
  if (!preferences || (preferences.priceMin === undefined && preferences.priceMax === undefined)) return true;
  const price = parseListingPrice(listing.price);
  if (price === undefined) return false; // "ASK"/unknown price can't be judged against a range
  if (preferences.priceMin !== undefined && price < preferences.priceMin) return false;
  if (preferences.priceMax !== undefined && price > preferences.priceMax) return false;
  return true;
}

/** How far outside the preferred range a listing's price sits — used to sort the fallback pool. */
function priceDistance(listing: InventoryListing, preferences?: SearchPreferences): number {
  if (!preferences || (preferences.priceMin === undefined && preferences.priceMax === undefined)) return 0;
  const price = parseListingPrice(listing.price);
  if (price === undefined) return Infinity;
  if (preferences.priceMin !== undefined && price < preferences.priceMin) return preferences.priceMin - price;
  if (preferences.priceMax !== undefined && price > preferences.priceMax) return price - preferences.priceMax;
  return 0;
}

/** Location/dial/condition are freeform text, so they nudge sort order rather than hard-exclude. */
function softPreferenceScore(listing: InventoryListing, preferences?: SearchPreferences): number {
  if (!preferences) return 0;
  let s = 0;
  const haystack = `${listing.description} ${listing.item}`.toLowerCase();
  if (preferences.location && listing.location.toLowerCase().includes(preferences.location)) s += 1;
  if (preferences.dialColor && haystack.includes(preferences.dialColor)) s += 1;
  if (preferences.condition && listing.condition.toLowerCase().includes(preferences.condition)) s += 1;
  return s;
}

/**
 * A buyer's request ("buy") matches against FS (for sale) listings;
 * a seller's request ("sell") matches against WTB (want to buy) listings.
 * `preferences` (price/location/dial/condition, collected once per contact) filters price
 * hard when set — falling back to sorting by closest price if that empties the pool — and
 * nudges sort order for the freeform fields.
 *
 * When the query names a specific reference number, that's a hard filter: only listings whose
 * own `ref` normalizes to an exact match are ever returned — never falling back to keyword
 * overlap or (if nothing matches) the "show something anyway" pool below. A reference search
 * is a request for THAT watch, not something similar; an empty result here is exactly what
 * should happen, and the caller (flow.ts) already turns zero matches into "I'll keep watching
 * the network" rather than silence.
 */
export async function findMatches(request: ItemRequest, limit: number, preferences?: SearchPreferences): Promise<InventoryListing[]> {
  const wantType = request.action === "buy" ? "FS" : "WTB";
  const candidates = await getActiveListings(wantType);
  const requestedRef = extractRequestedReference(request.query);

  if (requestedRef) {
    const exact = candidates.filter((l) => l.ref && referencesMatch(l.ref, requestedRef));
    const priceFiltered = exact.filter((l) => inPriceRange(l, preferences));
    const pool = priceFiltered.length > 0 ? priceFiltered : exact;
    const ranked = pool
      .map((listing) => ({
        listing,
        prefScore: softPreferenceScore(listing, preferences),
        priceDist: priceDistance(listing, preferences),
      }))
      .sort(
        (a, b) =>
          b.prefScore - a.prefScore || a.priceDist - b.priceDist || Number(b.listing.rating) - Number(a.listing.rating)
      );
    return ranked.slice(0, limit).map((r) => r.listing);
  }

  const tokens = tokenize(request.query);
  const priceFiltered = candidates.filter((l) => inPriceRange(l, preferences));
  const pool = priceFiltered.length > 0 ? priceFiltered : candidates;

  const ranked = pool
    .map((listing) => ({
      listing,
      tokenScore: score(listing, tokens),
      prefScore: softPreferenceScore(listing, preferences),
      priceDist: priceDistance(listing, preferences),
    }))
    .sort(
      (a, b) =>
        b.tokenScore - a.tokenScore ||
        b.prefScore - a.prefScore ||
        a.priceDist - b.priceDist ||
        Number(b.listing.rating) - Number(a.listing.rating)
    );

  // No token overlap — fall back to the full ranked pool (still price/pref/rating sorted)
  // so the trial always demonstrates value instead of returning nothing.
  const withTokenMatch = ranked.filter((r) => r.tokenScore > 0);
  const finalPool = withTokenMatch.length > 0 ? withTokenMatch : ranked;

  return finalPool.slice(0, limit).map((r) => r.listing);
}

function watchName(listing: InventoryListing): string {
  if (listing.description) return listing.description;
  return listing.item.toLowerCase().startsWith(listing.brand.toLowerCase())
    ? listing.item
    : `${listing.brand} ${listing.item}`;
}

/**
 * Fi Conversation Flow Spec (v3) §2 Match Card — counterparty name and watch details are
 * shown up front (no separate anonymized/reveal step); "approve"/"pass" is what's metered
 * against the trial, and approving is what additionally surfaces the phone number.
 * "Fi Intelligence" (dealer reputation, price trend, market range, authenticity) is omitted
 * — no data source for any of that exists in the pipeline yet.
 */
function sourceLabel(listing: InventoryListing): string {
  if (listing.source === "WF") return "WatchFacts";
  return listing.source || "Unknown";
}

export function formatMatchCard(listing: InventoryListing, index: number, action: ItemRequest["action"]): string {
  const roleLabel = action === "buy" ? "Seller" : "Buyer";
  const priceLabel = action === "buy" ? "Asking" : "Bid";
  const priceText = listing.price === "ASK" ? "price on ask" : `$${listing.price}`;
  const watchLine = listing.ref ? `${watchName(listing)} (Ref. ${listing.ref})` : watchName(listing);
  const lines = [
    `Potential Match #${index + 1}`,
    `${roleLabel}: ${listing.contactName || "Unnamed"}`,
    `Watch: ${watchLine}`,
    `${priceLabel}: ${priceText}`,
    `Location: ${listing.location || "Not specified"}`,
    `Source: ${sourceLabel(listing)}`,
  ];
  if (listing.detailUrl) lines.push(`Listing: ${listing.detailUrl}`);
  return lines.join("\n");
}

/** Sent after "approve <n>" — adds the phone number so the two sides can actually connect. */
export function formatMatchApproved(listing: InventoryListing, index: number): string {
  return `Approved #${index + 1} — connecting you with ${listing.contactName || "them"}: ${listing.contactPhone}`;
}
