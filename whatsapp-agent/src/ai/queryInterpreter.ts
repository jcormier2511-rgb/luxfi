import { callAiJson } from "./client";
import { InterpretedQuery } from "./types";
import { SearchPreferences } from "../types";
import { parsePriceRange } from "../conversation/preferences";
import { detectCurrency } from "../matching/currency";
import { extractReference } from "../postings/normalize";

export interface ConfirmedNaturalLanguageIntent {
  intent: "buy" | "sell" | null;
  brand: string | null;
  reference: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
}

const CURRENCY_MARKER = String.raw`(?:HK\$|C\$|S\$|CN¥|[$€£¥]|\b(?:USD|HKD|EUR|GBP|AED|CHF|CAD|SGD|JPY|CNY|RMB)\b)`;
const PRICE_NUMBER = String.raw`[\d][\d.,]*(?:\s*[kK]\b)?`;
const PRICE_COMPARATOR = String.raw`\b(?:under|up to|max(?:imum)?|below|less than|over|at least|min(?:imum)?|above|more than|budget(?:\s+of)?|around|about)\b`;

/** Returns only the explicit price-bearing substring, never an earlier watch reference. */
function extractExplicitPriceExpression(text: string): string | null {
  const patterns = [
    // A range must win before a leading comparator such as "budget" can truncate it to the
    // first endpoint ("budget $80k-$100k" must mean 80k-100k, never a max of 80k).
    new RegExp(`(?:${CURRENCY_MARKER}\\s*)?${PRICE_NUMBER}(?![A-Z0-9])\\s*(?:-|to|–)\\s*(?:${CURRENCY_MARKER}\\s*)?${PRICE_NUMBER}(?![A-Z0-9])`, "i"),
    new RegExp(`${PRICE_COMPARATOR}\\s*(?:${CURRENCY_MARKER}\\s*)?${PRICE_NUMBER}(?![A-Z0-9])`, "i"),
    new RegExp(`${CURRENCY_MARKER}\\s*${PRICE_NUMBER}(?![A-Z0-9])`, "i"),
    new RegExp(`${PRICE_NUMBER}(?![A-Z0-9])\\s*${CURRENCY_MARKER}`, "i"),
    /\b\d{1,3}(?:[.,]\d+)?\s*k\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function removeExplicitPriceExpressions(text: string): string {
  const currencyFirst = new RegExp(`${CURRENCY_MARKER}\\s*${PRICE_NUMBER}(?![A-Z0-9])`, "gi");
  const currencyLast = new RegExp(`${PRICE_NUMBER}(?![A-Z0-9])\\s*${CURRENCY_MARKER}`, "gi");
  const compared = new RegExp(`${PRICE_COMPARATOR}\\s*(?:${CURRENCY_MARKER}\\s*)?${PRICE_NUMBER}(?![A-Z0-9])`, "gi");
  return text
    .replace(currencyFirst, " ")
    .replace(currencyLast, " ")
    .replace(compared, " ")
    .replace(/\b\d{1,3}(?:[.,]\d+)?\s*k\b/gi, " ")
    .replace(/\b\d[\d.,]*\s*(?:-|to|–)\s*\d[\d.,]*(?:\s*k\b)?/gi, " ");
}

/**
 * Deterministic extraction for explicit, safety-critical constraints. The AI still handles
 * fuzzy attributes, but cannot shrink a comma-formatted price ceiling (for example $110,000
 * to $110). This also provides one inspectable representation of the fields the webhook uses.
 */
export function extractConfirmedNaturalLanguageIntent(text: string): ConfirmedNaturalLanguageIntent {
  // Explicit buyer language wins when seller-oriented words merely describe the desired item
  // ("looking to buy ... that's for sale"), matching the deterministic posting classifier.
  const intent = /\b(buy|buying|looking for|want|need|wtb|iso)\b/i.test(text)
    ? "buy"
    : /\b(sell|selling|fs|for sale|wts)\b/i.test(text)
      ? "sell"
      : null;
  const brand = /\bpatek(?:\s+philippe)?\b/i.test(text) ? "Patek Philippe" : null;
  const reference = extractReference(removeExplicitPriceExpressions(text));
  const priceExpression = extractExplicitPriceExpression(text);
  const priceRange = priceExpression ? parsePriceRange(priceExpression) : undefined;
  const priceMin = priceRange?.min ?? null;
  const priceMax = priceRange?.max ?? null;
  const currency = priceMin === null && priceMax === null ? null : detectCurrency(priceExpression ?? "");
  return { intent, brand, reference, priceMin, priceMax, currency };
}

const INTERPRET_SYSTEM = `You convert a WhatsApp message into structured shopping intent for a luxury watch marketplace.
Rules:
- action is "buy" for someone wanting to acquire a watch (buy/find/search/available/looking for/ISO/need), or "sell" for someone offering one (sell/selling/FS/WTS).
- referenceFamily is the base reference number if one is named (e.g. "116500" from "116500LN" or "Daytona 116500"), without a dial/bracelet-code suffix. Leave it null if no reference is named.
- dialColor and condition are read directly off the message (e.g. "black dial" -> "black"; "pre-owned"/"used"/"new" -> that word). Leave null if not mentioned — never guess one.
- hardRequirements are constraints that MUST hold (an explicit reference, an explicit "under $X" price ceiling). preferences are soft/nice-to-have details (color, box/papers, condition) that should never exclude an otherwise-good match on their own.
- Respond with ONLY a JSON object, no prose, no markdown fence, with exactly these keys: action, brand, referenceFamily, maxPrice, minPrice, location, dialColor, condition, hardRequirements (string array), preferences (string array). Use null for any field you can't determine, and [] for no requirements/preferences.`;

/** Returns null (never throws) on any failure/disabled state — callers keep the existing deterministic parser as the real fallback. */
export async function interpretQuery(text: string): Promise<InterpretedQuery | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const result = await callAiJson<InterpretedQuery>({ system: INTERPRET_SYSTEM, user: trimmed, maxTokens: 512 });
  if (!result || (result.action !== "buy" && result.action !== "sell")) return null;
  const confirmed = extractConfirmedNaturalLanguageIntent(trimmed);
  if (confirmed.intent) result.action = confirmed.intent;
  if (confirmed.brand) result.brand = confirmed.brand;
  if (confirmed.reference) result.referenceFamily = confirmed.reference;
  if (confirmed.priceMin !== null || confirmed.priceMax !== null) {
    // Once an explicit price expression has been verified deterministically, replace both AI
    // bounds. This prevents an explicit minimum from retaining an invented AI maximum (and
    // likewise prevents an explicit ceiling from retaining an invented minimum).
    result.minPrice = confirmed.priceMin;
    result.maxPrice = confirmed.priceMax;
  }
  if (confirmed.currency) result.currency = confirmed.currency;
  return result;
}

/**
 * Lets a single free-form message stand in for the old price → location → dial → condition
 * interview (see conversation/flow.ts) — only the fields the model actually found are set, so
 * an unmentioned field stays undefined ("no preference"), exactly like answering "any" in the
 * old interview.
 */
export function toSearchPreferences(interpreted: InterpretedQuery): SearchPreferences {
  const prefs: SearchPreferences = {};
  if (interpreted.minPrice !== null) prefs.priceMin = interpreted.minPrice;
  if (interpreted.maxPrice !== null) prefs.priceMax = interpreted.maxPrice;
  if (interpreted.currency) prefs.priceCurrency = interpreted.currency;
  if (interpreted.location !== null) prefs.location = interpreted.location;
  if (interpreted.dialColor !== null) prefs.dialColor = interpreted.dialColor;
  if (interpreted.condition !== null) prefs.condition = interpreted.condition;
  return prefs;
}
