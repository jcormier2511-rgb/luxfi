import { InventoryListing } from "../types";
import { normalizeReference, referencesMatch, normalizePriceShorthand } from "../postings/normalize";

export type PriceSignal = "Attractive" | "Fair" | "High";

// A listing needs at least this many *other* active FS listings for the same reference before
// its price is judged against them at all -- comparing against 0 or 1 data points isn't a
// comparison, it's a guess dressed up as one.
const MIN_COMPARABLE_LISTINGS = 2;

// Ratios against the comp median. Deliberately wide (not +/-5%) -- comps here are other
// dealers' asking prices for the same reference, which routinely vary by condition/box-and-
// papers/dial variant even within one reference family, so a tight band would flag normal
// listing-to-listing variation as anomalous rather than a real outlier.
const ATTRACTIVE_RATIO = 0.85;
const HIGH_RATIO = 1.15;

function parsePrice(raw: string): number | undefined {
  const n = normalizePriceShorthand(raw);
  return n === null ? undefined : n;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compares `listing`'s price against the median price of other active FS listings sharing the
 * same reference, drawn entirely from `comparablePool` (the caller's already-fetched active-FS
 * listings -- no extra DB query happens in here). No external pricing source; comps come only
 * from inventory already synced from WatchFacts.
 *
 * Returns null -- omit the signal, never guess -- whenever there isn't enough to compare
 * against: no parseable price on the listing, no reference, or fewer than
 * MIN_COMPARABLE_LISTINGS other listings for that same reference.
 *
 * This does not fix a bad price extraction upstream (e.g. a bezel/part price stored as the
 * listing's own price instead of the watch's -- the live case this was built for). What it
 * does is make that kind of anomaly visible: a price far below real comps for the same
 * reference surfaces as "Attractive" here, which is at least a signal to double-check rather
 * than a silent, ordinary-looking match.
 */
export function computePriceSignal(listing: InventoryListing, comparablePool: InventoryListing[]): PriceSignal | null {
  const price = parsePrice(listing.price);
  if (price === undefined || !listing.ref) return null;

  const ref = normalizeReference(listing.ref);
  const comps = comparablePool
    .filter((l) => l.id !== listing.id && l.type === "FS" && l.ref && referencesMatch(l.ref, ref))
    .map((l) => parsePrice(l.price))
    .filter((p): p is number => p !== undefined);

  if (comps.length < MIN_COMPARABLE_LISTINGS) return null;

  const med = median(comps);
  if (med <= 0) return null;

  const ratio = price / med;
  if (ratio <= ATTRACTIVE_RATIO) return "Attractive";
  if (ratio >= HIGH_RATIO) return "High";
  return "Fair";
}
