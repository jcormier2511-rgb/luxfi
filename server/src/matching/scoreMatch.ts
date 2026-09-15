/**
 * Pure matching logic between a WTB (want-to-buy) listing and an FS
 * (for-sale) listing. No I/O — kept separate from matchingService.ts so it
 * can be unit tested directly and reused for both live matching and any
 * future backfill/reprocessing job.
 */

export interface ListingLike {
  dealerId: string;
  category: string;
  brand: string | null;
  reference: string | null;
  priceMin: number | null;
  priceMax: number | null;
  location: string | null;
}

const normalize = (s: string) => s.trim().toLowerCase();
const normalizeRef = (s: string) => s.replace(/[\s\-.\/]/g, "").toLowerCase();

/**
 * Returns a match score (higher = better) or null if the pair doesn't
 * qualify as a match at all. A brand match is required on both sides —
 * dealer shorthand almost always names the brand, and matching purely on
 * price would produce false positives.
 */
export function scoreMatch(wtb: ListingLike, fs: ListingLike): number | null {
  if (wtb.dealerId === fs.dealerId) return null;
  if (wtb.category !== fs.category) return null;
  if (!wtb.brand || !fs.brand) return null;
  if (normalize(wtb.brand) !== normalize(fs.brand)) return null;

  let score = 40;

  if (wtb.reference && fs.reference) {
    if (normalizeRef(wtb.reference) !== normalizeRef(fs.reference)) return null;
    score += 100;
  }

  const sellerAsk = fs.priceMin ?? fs.priceMax;
  const buyerMax = wtb.priceMax ?? wtb.priceMin;
  if (sellerAsk != null && buyerMax != null) {
    const slack = buyerMax * 1.05; // allow the ask to run 5% over the buyer's stated max
    if (sellerAsk > slack) return null;
    const proximity = Math.max(0, 1 - Math.abs(buyerMax - sellerAsk) / buyerMax);
    score += 30 * proximity;
  }

  if (wtb.location && fs.location && normalize(wtb.location) === normalize(fs.location)) {
    score += 10;
  }

  return score;
}

/** Picks the best-scoring FS listing for a WTB listing, if any qualify. */
export function bestMatch<T extends ListingLike>(wtb: ListingLike, candidates: T[]): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreMatch(wtb, candidate);
    if (score !== null && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
