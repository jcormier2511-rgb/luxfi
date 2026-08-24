/**
 * Heuristic parser that turns a raw dealer-group chat message into a
 * structured listing when it looks like a WTB ("want to buy") or
 * FS/WTS ("for sale") post. Returns null for anything else (chit-chat,
 * questions, replies) so it's never mistaken for a listing.
 *
 * This is intentionally rule-based rather than ML-based: dealer group
 * shorthand is terse and formulaic ("WTB Daytona 116500LN $18-20k CH"),
 * and a deterministic parser is easy to reason about, test, and extend
 * with more brands/patterns over time.
 */

export type ListingType = "WTB" | "FS";

export interface ParsedListing {
  type: ListingType;
  brand: string | null;
  reference: string | null;
  model: string | null;
  condition: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  location: string | null;
  notes: string | null;
}

const WTB_PATTERN = /\b(wtb|want\s*to\s*buy|iso|looking\s*for)\b/i;
const FS_PATTERN = /\b(fs|wts|for\s*sale|selling)\b/i;

// Extend as new categories/brands come online.
const KNOWN_BRANDS = [
  "rolex",
  "patek philippe",
  "patek",
  "audemars piguet",
  "ap",
  "omega",
  "cartier",
  "richard mille",
  "vacheron constantin",
  "hublot",
  "panerai",
  "iwc",
  "breitling",
  "tudor",
  "chanel",
  "hermes",
  "hermès",
  "louis vuitton",
  "gucci",
  "van cleef",
  "van cleef & arpels",
  "tiffany",
  "bulgari",
];

const CONDITION_KEYWORDS = [
  "nos",
  "lnib",
  "new",
  "unworn",
  "brand new",
  "complete set",
  "full set",
  "ch", // complete set / box+papers, dealer shorthand
  "b/p",
  "box and papers",
  "pre-owned",
  "preowned",
  "used",
  "excellent",
  "good condition",
];

// e.g. 116500LN, 126610LN, 5711/1A, 26470ST.OO.A104CR.01
const REFERENCE_PATTERN = /\b(\d{4,6}[A-Z]{0,3}(?:[.\/][A-Z0-9.]{2,15})?)\b/;

function extractPriceRange(text: string): { min: number | null; max: number | null } {
  // Range like "$18k-20k", "18,000-20,000", "$18,500 to $20,000"
  const rangeMatch = text.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*k?\s*(?:-|to|–)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,
  );
  if (rangeMatch?.[1] && rangeMatch[2]) {
    const min = normalizeAmount(rangeMatch[1], text);
    const max = normalizeAmount(rangeMatch[2], text);
    if (min !== null && max !== null) return { min, max };
  }

  // Single price like "$18,500" or "18.5k"
  const singleMatch = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*k?\b/i) ?? text.match(/\b([\d,]+(?:\.\d+)?)\s*k\b/i);
  if (singleMatch?.[1]) {
    const amount = normalizeAmount(singleMatch[1], singleMatch[0]);
    if (amount !== null) return { min: amount, max: amount };
  }

  return { min: null, max: null };
}

function normalizeAmount(raw: string, context: string): number | null {
  const cleaned = raw.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  const isThousands = /k\b/i.test(context) && value < 1000;
  return Math.round(isThousands ? value * 1000 : value);
}

function extractBrand(text: string): string | null {
  const lower = text.toLowerCase();
  for (const brand of KNOWN_BRANDS) {
    if (new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) {
      // Normalize a couple of common aliases to a canonical brand name.
      if (brand === "ap") return "Audemars Piguet";
      if (brand === "patek") return "Patek Philippe";
      return brand.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

function extractReference(text: string): string | null {
  const match = text.match(REFERENCE_PATTERN);
  return match?.[1]?.toUpperCase() ?? null;
}

function extractCondition(text: string): string | null {
  const lower = text.toLowerCase();
  const found = CONDITION_KEYWORDS.filter((kw) => new RegExp(`\\b${kw}\\b`, "i").test(lower));
  return found.length ? found.join(", ") : null;
}

const LOCATION_HINTS = [
  "nyc",
  "new york",
  "la",
  "los angeles",
  "miami",
  "chicago",
  "london",
  "geneva",
  "dubai",
  "hong kong",
  "singapore",
  "tokyo",
  "paris",
  "zurich",
];

function extractLocation(text: string): string | null {
  const lower = text.toLowerCase();
  for (const loc of LOCATION_HINTS) {
    if (new RegExp(`\\b${loc}\\b`, "i").test(lower)) {
      return loc.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

export function parseListing(rawText: string): ParsedListing | null {
  const text = rawText.trim();
  if (!text) return null;

  const isWtb = WTB_PATTERN.test(text);
  const isFs = FS_PATTERN.test(text);

  // Ambiguous or neither — don't guess, treat as non-listing chatter.
  if (isWtb === isFs) return null;

  const type: ListingType = isWtb ? "WTB" : "FS";
  const { min, max } = extractPriceRange(text);

  return {
    type,
    brand: extractBrand(text),
    reference: extractReference(text),
    model: null,
    condition: extractCondition(text),
    priceMin: min,
    priceMax: max,
    currency: "USD",
    location: extractLocation(text),
    notes: null,
  };
}
