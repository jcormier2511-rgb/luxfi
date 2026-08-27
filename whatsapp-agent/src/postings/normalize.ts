/**
 * Deterministic, regex-based extraction — the spec allows AI to extract/normalize and
 * explain matches, but explicitly forbids AI from controlling database identity, trial
 * usage, approval state, or billing. Keeping normalization itself deterministic sidesteps
 * that risk entirely for the MVP rather than needing to firewall an AI call's output.
 */

const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of|ntq)\b/i;
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling)\b/i;
const PRICE_PATTERN = /\$\s?[\d,]+(?:\.\d+)?/g;
// `(?<!\$\s?)` excludes a digit run directly preceded by a $ sign (with or without a space) —
// "$20000"/"$ 20000" is unambiguously a price, never a reference, even though bare "20000"
// alone would otherwise fit the same shape. This is the ONE disambiguation that's actually
// resolvable without guessing: a bare, contextless 4-digit number with no $ and no letters
// (e.g. a model year like "2023") is inherently indistinguishable from a real 4-digit
// reference (Patek 3700/5711, Rolex 1601, etc.) using pattern-matching alone, so that
// ambiguity is intentionally left unresolved rather than guessed at with a year-range heuristic
// that would just as often reject a legitimate reference search.
const REFERENCE_PATTERN = /(?<!\$\s?)\b(\d{4,6}[A-Z]{0,3}(?:[-/][A-Z0-9]+)?)\b/i;
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

/** Shared by v3 (matching/engine.ts) and v4 (this file) — one reference-extraction rule, not two hand-synced copies. */
export function extractReference(text: string): string | null {
  const m = text.match(REFERENCE_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

export function normalizeText(text: string): NormalizedFields {
  const lower = text.toLowerCase();
  const brand = BRAND_LIST.find((b) => lower.includes(b)) ?? "";
  return {
    brand,
    reference: extractReference(text) ?? "",
    price: extractUnambiguousPrice(text),
    currency: "USD",
  };
}
