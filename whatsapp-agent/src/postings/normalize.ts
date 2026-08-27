/**
 * Deterministic, regex-based extraction — the spec allows AI to extract/normalize and
 * explain matches, but explicitly forbids AI from controlling database identity, trial
 * usage, approval state, or billing. Keeping normalization itself deterministic sidesteps
 * that risk entirely for the MVP rather than needing to firewall an AI call's output.
 */

const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of|ntq)\b/i;
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling)\b/i;
const PRICE_PATTERN = /\$\s?[\d,]+(?:\.\d+)?/g;
const REFERENCE_PATTERN = /\b(\d{4,6}[A-Z]{0,3}(?:[-/][A-Z0-9]+)?)\b/i;
const BRAND_LIST = [
  "rolex",
  "patek philippe",
  "patek",
  "audemars piguet",
  "cartier",
  "richard mille",
  "hermes",
  "hermès",
  "panerai",
  "iwc",
  "vacheron constantin",
  "tudor",
  "omega",
];

export type PostingType = "FS" | "WTB";

export function classifyText(text: string): PostingType | null {
  if (FS_KEYWORDS.test(text)) return "FS";
  if (WTB_KEYWORDS.test(text)) return "WTB";
  return null;
}

export interface NormalizedFields {
  brand: string;
  reference: string;
  price: number | null;
  currency: string;
}

/**
 * Strips formatting (dashes, slashes, spaces) and uppercases, so "116508-0013" and
 * "1165080013" compare equal, and a reference captured from free text lines up with the same
 * reference as stored on a WatchFacts API listing detail. Used at COMPARISON time only — the
 * display-facing `reference` field below keeps its original, more readable form.
 */
export function normalizeReference(ref: string): string {
  return ref.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A single, unambiguous $-amount in the text. Multiple distinct price mentions (e.g. a
 * multi-item dealer price list dumped as one message) make it impossible to know which price
 * belongs to which item, so this returns null rather than guessing by picking the first one.
 */
function extractUnambiguousPrice(text: string): number | null {
  const matches = text.match(PRICE_PATTERN);
  if (!matches) return null;
  // Compare parsed numeric values, not raw match text — [\d,]+ is greedy enough to swallow a
  // sentence's own trailing comma (e.g. "$28,500, no lowballs" → "$28,500,"), which would
  // otherwise make the exact same price look like two different ones.
  const values = matches.map((m) => Number(m.replace(/[^\d.]/g, "")));
  const distinct = new Set(values);
  if (distinct.size !== 1) return null;
  const [only] = distinct;
  return Number.isFinite(only) ? only : null;
}

export function normalizeText(text: string): NormalizedFields {
  const refMatch = text.match(REFERENCE_PATTERN);
  const lower = text.toLowerCase();
  const brand = BRAND_LIST.find((b) => lower.includes(b)) ?? "";
  return {
    brand,
    reference: refMatch ? refMatch[1].toUpperCase() : "",
    price: extractUnambiguousPrice(text),
    currency: "USD",
  };
}
