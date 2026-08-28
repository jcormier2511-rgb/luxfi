import { callAiJson } from "./client";
import { config } from "../config";
import { normalizePriceShorthand } from "../postings/normalize";
import { detectCurrency, SUPPORTED_CURRENCIES } from "../matching/currency";

/**
 * The single structured shape every private WhatsApp message is converted into (Fi routing
 * fix): a buy/sell request built from THIS shape's brand/model/reference/searchText fields,
 * never from re-parsing the raw sentence with a prefix-stripping regex — that regex is exactly
 * what let phrases like "to buy a patek 5712G" leak into a stored search query. See
 * conversation/flow.ts for how this is used (deterministic action commands are checked BEFORE
 * this ever runs; this never fires for "approve 2"/"photos 1"/etc. — those are handled and
 * returned on earlier, unconditional branches).
 */
export type Intent =
  | "buy"
  | "sell"
  | "price_check"
  | "dealer_reference"
  | "request_photos"
  | "approve"
  | "pass"
  | "help"
  | "general_question"
  | "unknown";

export interface ExtractedIntent {
  intent: Intent;
  brand: string | null;
  model: string | null;
  reference: string | null;
  dial: string | null;
  condition: string | null;
  year: number | null;
  boxPapers: boolean | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  location: string | null;
  searchText: string | null;
  confidence: number;
}

// Common shorthand/misspellings mapped to the canonical brand name a listing's own `brand`
// field and the deterministic BRAND_LIST (postings/normalize.ts) both use. Keeps "Patek" and
// "Patek Philippe" from ever being treated as two different brands downstream.
const BRAND_CANONICAL: Record<string, string> = {
  patek: "Patek Philippe",
  "patek philippe": "Patek Philippe",
  pp: "Patek Philippe",
  ap: "Audemars Piguet",
  audemars: "Audemars Piguet",
  "audemars piguet": "Audemars Piguet",
  rolex: "Rolex",
  vc: "Vacheron Constantin",
  vacheron: "Vacheron Constantin",
  "vacheron constantin": "Vacheron Constantin",
  rm: "Richard Mille",
  "richard mille": "Richard Mille",
  hermes: "Hermès",
  "hermès": "Hermès",
  panerai: "Panerai",
  iwc: "IWC",
  tudor: "Tudor",
  omega: "Omega",
  cartier: "Cartier",
};

function canonicalBrand(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return BRAND_CANONICAL[key] ?? raw.trim();
}

const VALID_INTENTS: Intent[] = [
  "buy",
  "sell",
  "price_check",
  "dealer_reference",
  "request_photos",
  "approve",
  "pass",
  "help",
  "general_question",
  "unknown",
];

const INTENT_SYSTEM = `You convert one WhatsApp message into structured shopping intent for a luxury watch marketplace. Respond with ONLY a JSON object, no prose, no markdown fence, with exactly these keys: intent, brand, model, reference, dial, condition, year, boxPapers, priceMin, priceMax, currency, location, searchText, confidence.

intent is exactly one of: "buy" (wants to acquire a watch — buy/find/search/available/looking for/ISO/need/WTB), "sell" (offering one — sell/selling/FS/WTS/"I have"), "price_check" (asking what something is worth, no buy/sell action), "dealer_reference" (asking about a dealer's reputation/references), "request_photos" (asking to see photos of something already shown), "approve" (accepting/connecting on something already shown), "pass" (skipping something already shown), "help" (asking what Fi can do), "general_question" (anything else conversational), or "unknown" (can't tell).

brand is the FULL canonical maker name (e.g. "Patek" or "PP" -> "Patek Philippe", "AP" -> "Audemars Piguet") — null if none is named.
model is the model line if named (e.g. "Daytona", "Nautilus") — null if only a brand/reference is given.
reference is the reference number exactly as written (e.g. "5712", "5712G", "116500LN") — a bare reference-shaped number is NEVER a price, and a 4-digit year is NEVER a reference.
dial and condition are read directly off the message — null if not mentioned, never guessed.
year is a 4-digit model/production year if explicitly mentioned as a year (not a reference) — else null.
boxPapers is true only if box and/or papers are explicitly mentioned as included, false only if explicitly mentioned as NOT included/missing, else null.
priceMin/priceMax are numbers in the given currency, extracted ONLY from a number clearly adjacent to a supported currency marker (USD/HKD/EUR/GBP/AED/CHF/CAD/SGD/JPY/CNY/RMB, including $/HK$/€/£/C$/S$/¥/CN¥) or a "k"/"K" shorthand suffix — NEVER from a bare reference number or a bare 4-digit year. "105.000 USD" and "105,000 USD" and "$105,000" all mean 105000. "26.2k" means 26200. A single stated ceiling ("under 25k") sets priceMax only; a single stated floor sets priceMin only; a range sets both. Leave both null if no reliable price is stated — never guess a number.
currency is the 3-letter code (default "USD" if a $ sign or no currency is given but a price was found).
location is a stated country/region/city — null if not mentioned.
searchText is brand + model + reference, cleanly joined (e.g. "Patek Philippe 5712G") — never the raw sentence, never a leftover fragment like "to buy a patek 5712g".
confidence is 0-1, your own confidence that intent/brand/model/reference are all correctly identified — use a LOW value (under 0.5) rather than guessing when the message is ambiguous.`;

const LOW_CONFIDENCE_THRESHOLD = 0.5;

function isValidIntent(value: unknown): value is Intent {
  return typeof value === "string" && (VALID_INTENTS as string[]).includes(value);
}

/**
 * A deterministic price-signal detector for a BUYER'S OWN natural-language message — distinct
 * from postings/normalize.ts's WatchFacts-listing-oriented PRICE_PATTERN, which deliberately
 * requires a $ sign or currency CODE even next to a "k" suffix (so a listing's "18k gold"
 * material description is never misread as an $18,000 price). A buyer's own message is a much
 * narrower context where a bare "k"/"K" suffix ("under 25k") is itself a reliable price marker
 * per spec, so this pattern accepts one on its own — with the one carve-out that actually
 * matters here too: "18k gold"/"14k white gold" etc. are still purity mentions, not a price,
 * even in a buyer's own sentence, so a k-suffixed number immediately followed by a gold/karat
 * word is excluded.
 */
// Derive the verifier's code list from the matching engine's real supported-currency list so
// the primary NLU path cannot silently lag behind conversion/matching when a currency is added.
// RMB is an accepted alias for CNY. Multi-character symbols must precede the bare symbols they
// contain, otherwise "HK$" could be read as a generic "$" price.
const CURRENCY_CODE = `(?:${[...SUPPORTED_CURRENCIES, "RMB"].join("|")})`;
const CURRENCY_SYMBOL = "(?:HK\\$|C\\$|S\\$|A\\$|CN¥|[$€£¥])";
const NUM = "(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)";
const NL_PRICE_PATTERN = new RegExp(
  `${CURRENCY_SYMBOL}\\s?${NUM}\\s?[kK]?\\b` + // $105,000 / $25k / €5000
    `|\\b${CURRENCY_CODE}\\s?${NUM}\\s?[kK]?\\b` + // USD 105000
    `|\\b${NUM}\\s?[kK]?\\s?${CURRENCY_CODE}\\b` + // 105.000 USD / 105k USD
    `|\\b${NUM}\\s?[kK]\\b`, // bare 25k / 26.2k -- no currency marker at all
  "gi"
);
const GOLD_PURITY_WORD = /^\s*(gold|karat|kt\b|white\s+gold|yellow\s+gold|rose\s+gold)/i;

/** Every distinct normalized price value the raw text unambiguously names, excluding a
 *  k-suffixed number immediately followed by a gold/karat word (a material, not a price). */
function nlPriceMentions(text: string): { value: number; currency: string }[] {
  const mentions: { value: number; currency: string }[] = [];
  const re = new RegExp(NL_PRICE_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const after = text.slice(m.index + m[0].length);
    if (!GOLD_PURITY_WORD.test(after)) {
      const value = normalizePriceShorthand(m[0]);
      const currency = detectCurrency(m[0]);
      if (value !== null && currency) mentions.push({ value, currency });
    }
  }
  return mentions;
}

function nlPriceValues(text: string): Set<number> {
  return new Set(nlPriceMentions(text).map((mention) => mention.value));
}

/** Canonical currency from the same verified price token(s), never the model or unrelated text. */
export function extractVerifiedPriceCurrency(text: string): string | null {
  // A single prefix/suffix currency applies to both endpoints of a range. Without this,
  // "800k-900k HKD" looks like one implicit-USD token plus one HKD token.
  const markedRangePatterns = [
    new RegExp(`(?:${CURRENCY_SYMBOL}|\\b${CURRENCY_CODE}\\b)\\s*${NUM}\\s?[kK]?\\s*(?:-|to|–)\\s*(?:${CURRENCY_SYMBOL}\\s*)?${NUM}\\s?[kK]?`, "i"),
    new RegExp(`${NUM}\\s?[kK]?\\s*(?:-|to|–)\\s*(?:${CURRENCY_SYMBOL}\\s*)?${NUM}\\s?[kK]?\\s*(?:${CURRENCY_SYMBOL}|\\b${CURRENCY_CODE}\\b)`, "i"),
  ];
  for (const pattern of markedRangePatterns) {
    const range = text.match(pattern)?.[0];
    if (range) return detectCurrency(range);
  }
  const currencies = new Set(nlPriceMentions(text).map((mention) => mention.currency));
  return currencies.size === 1 ? [...currencies][0] : null;
}

/**
 * A price-shaped field the model returned is only trusted when the raw message itself actually
 * contains exactly one unambiguous, currency/k-adjacent price — the deterministic backstop
 * against a hallucinated or misread price (e.g. reading "5712G" as "$2"), independent of
 * whatever the model claims. Returns "unreliable" (never a number) when the text has zero or
 * more than one distinct price mention — genuinely unverifiable, not a single ceiling/floor.
 */
function verifiedPrice(claimed: number | null, rawText: string): number | null | "unreliable" {
  if (claimed === null) return null;
  const found = nlPriceValues(rawText);
  if (found.size === 1) return [...found][0];
  // A real range contains two values. Trust each claimed endpoint only when it exactly appears
  // in that verified set; a third/invented value remains unreliable.
  return found.has(claimed) ? claimed : "unreliable";
}

export interface IntentExtractionResult {
  intent: ExtractedIntent;
  /** True when either priceMin or priceMax was claimed but couldn't be verified against the
   *  raw text's own unambiguous price pattern — callers should show "Price: Not reliably
   *  parsed" rather than the (possibly wrong) claimed number. */
  priceUnreliable: boolean;
}

/**
 * Returns null (never throws) on any failure/disabled state — callers fall back to the
 * deterministic legacy parser. Only ever called when AI matching is enabled for this phone
 * (see config.isAiMatchingEnabledForPhone) — every other contact keeps the deterministic path.
 */
export async function extractIntent(text: string): Promise<IntentExtractionResult | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const result = await callAiJson<ExtractedIntent>({ system: INTENT_SYSTEM, user: trimmed, maxTokens: 512 });
  console.log(`[nlu] provider=${config.aiMatching.provider}`);
  if (!result || !isValidIntent(result.intent)) {
    console.log(`[nlu] intent=none confidence=0`);
    return null;
  }

  const brand = canonicalBrand(result.brand ?? null);
  const model = result.model?.trim() || null;
  const reference = result.reference?.trim() || null;
  const searchText = [brand, model, reference].filter(Boolean).join(" ").trim() || result.searchText?.trim() || null;

  const minCheck = verifiedPrice(result.priceMin ?? null, trimmed);
  const maxCheck = verifiedPrice(result.priceMax ?? null, trimmed);
  const checkedPriceMin = minCheck === "unreliable" ? null : minCheck;
  const checkedPriceMax = maxCheck === "unreliable" ? null : maxCheck;
  const verifiedCurrency = extractVerifiedPriceCurrency(trimmed);
  const currencyUnreliable = (checkedPriceMin !== null || checkedPriceMax !== null) && verifiedCurrency === null;
  const priceUnreliable = minCheck === "unreliable" || maxCheck === "unreliable" || currencyUnreliable;
  const priceMin = currencyUnreliable ? null : checkedPriceMin;
  const priceMax = currencyUnreliable ? null : checkedPriceMax;

  const confidence = typeof result.confidence === "number" && Number.isFinite(result.confidence) ? result.confidence : 0;

  const normalized: ExtractedIntent = {
    intent: result.intent,
    brand,
    model,
    reference,
    dial: result.dial?.trim() || null,
    condition: result.condition?.trim() || null,
    year: typeof result.year === "number" ? result.year : null,
    boxPapers: typeof result.boxPapers === "boolean" ? result.boxPapers : null,
    priceMin,
    priceMax,
    currency: verifiedCurrency ?? detectCurrency(result.currency?.trim() || "USD") ?? "USD",
    location: result.location?.trim() || null,
    searchText,
    confidence,
  };

  console.log(`[nlu] intent=${normalized.intent} confidence=${confidence}`);
  if (searchText) console.log(`[nlu] normalized=${searchText}`);

  return { intent: normalized, priceUnreliable };
}

/** A result is only acted on directly when the model is reasonably sure — otherwise the caller
 *  falls back to the deterministic legacy parser rather than trusting a low-confidence guess. */
export function isConfidentIntent(result: IntentExtractionResult): boolean {
  return result.intent.confidence >= LOW_CONFIDENCE_THRESHOLD && result.intent.intent !== "unknown";
}
