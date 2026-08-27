/**
 * Deterministic, regex-based extraction — the spec allows AI to extract/normalize and
 * explain matches, but explicitly forbids AI from controlling database identity, trial
 * usage, approval state, or billing. Keeping normalization itself deterministic sidesteps
 * that risk entirely for the MVP rather than needing to firewall an AI call's output.
 */

const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of|ntq)\b/i;
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling)\b/i;
const PRICE_PATTERN = /\$\s?([\d,]+(?:\.\d+)?)/;
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

export function normalizeText(text: string): NormalizedFields {
  const priceMatch = text.match(PRICE_PATTERN);
  const refMatch = text.match(REFERENCE_PATTERN);
  const lower = text.toLowerCase();
  const brand = BRAND_LIST.find((b) => lower.includes(b)) ?? "";
  return {
    brand,
    reference: refMatch ? refMatch[1].toUpperCase() : "",
    price: priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null,
    currency: "USD",
  };
}
