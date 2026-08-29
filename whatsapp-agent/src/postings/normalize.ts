/**
 * Deterministic, regex-based extraction — the spec allows AI to extract/normalize and
 * explain matches, but explicitly forbids AI from controlling database identity, trial
 * usage, approval state, or billing. Keeping normalization itself deterministic sidesteps
 * that risk entirely for the MVP rather than needing to firewall an AI call's output.
 */

const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of|ntq|wanted|need|buying)\b/i;
// "ready stock"/"in stock"/"available" are dealer-inventory shorthand — a group post announcing
// what's on hand is a FS signal exactly like "for sale" is, just phrased as availability rather
// than an offer to sell.
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling|ready\s+stock|in\s+stock|available)\b/i;
// A price isn't always $-prefixed — overseas dealer price lists (the real-world bug this
// pattern was extended for: a Hong Kong dealer's "116500ln white 2011 hkd210k" bundle blast)
// write the currency code directly against the number instead, either before ("hkd210k") or
// after ("25,5usd", already handled by normalizePriceShorthand's "first currency wins" rule —
// see below). Recognizing these here (not just $-amounts) is what lets hasMultipleDistinctPrices
// actually detect that kind of listing as the multi-item dump it is.
const CURRENCY_CODE = "(?:usd|cad|hkd|eur|gbp|aed|sgd|aud|jpy|cny|rmb|chf)";
// Longest-first prevents the bare "$" branch from splitting HK$/C$/S$/A$, while including euro,
// pound, yen, and yuan symbols makes symbol-only overseas listings real priced inventory.
const GENERIC_DOLLAR = "(?<![A-Za-z])\\$";
const SPECIFIC_CURRENCY_SYMBOL = "(?:US\\$|HK\\$|C\\$|S\\$|A\\$|CN¥|[€£¥])";
// Trailing `\s?[kK]?` captures dealer shorthand like "$25.5k" — see normalizePriceShorthand,
// which does the actual k-multiplication; this pattern just needs to not truncate it away.
// Must start with an actual digit — a naive `[\d,]+` also matches a BARE comma (no digits at
// all), which let a stray ", " right before an unrelated currency code (e.g. "Sold, USD wire
// only") turn into a phantom price token. Requires either proper thousands-grouped digits or a
// plain unbroken digit run.
// Accept repeated comma OR dot thousands groups ("1,250,000" / "1.250.000"), while retaining
// short-decimal shorthand such as "25.5k". The old single-dot tail truncated €1.250.000.
const NUM = "(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d{1,2})?)\\s?[kK]?";
const PRICE_PATTERN = new RegExp(
  `(?:${SPECIFIC_CURRENCY_SYMBOL})\\s?${NUM}\\b` +
    `|(?:${GENERIC_DOLLAR})\\s?${NUM}\\b(?:\\s*${CURRENCY_CODE}\\b)?` +
    `|\\b${CURRENCY_CODE}\\s?${NUM}\\b` +
    // A reference can sit immediately before a currency-prefixed price, as in
    // "Rolex 126333 RMB 137000". Do not consume "126333 RMB" as a trailing-code
    // price when that currency is itself followed by another numeric token.
    `|\\b${NUM}\\s?${CURRENCY_CODE}\\b(?!\\s*${NUM})`,
  "gi"
);
// `(?<!\$\s?)` excludes a digit run directly preceded by a $ sign (with or without a space) —
// "$20000"/"$ 20000" is unambiguously a price, never a reference, even though bare "20000"
// alone would otherwise fit the same shape. This is the ONE disambiguation that's actually
// resolvable without guessing: a bare, contextless 4-digit number with no $ and no letters
// (e.g. a model year like "2023") is inherently indistinguishable from a real 4-digit
// reference (Patek 3700/5711, Rolex 1601, etc.) using pattern-matching alone, so that
// ambiguity is intentionally left unresolved rather than guessed at with a year-range heuristic
// that would just as often reject a legitimate reference search.
// Trailing separator group allows for real reference shapes beyond a single dash/slash suffix:
// Patek uses a dot ("3510.50") and can chain more than one separator ("5712/1A-001"), so the
// group repeats (`*`) and accepts `.` alongside `-`/`/`.
const REFERENCE_PATTERN = /(?<!\$\s?)\b(\d{4,6}[A-Z]{0,3}(?:[-/.][A-Z0-9]+)*)\b/i;
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

/** True when `text` names a known maker brand — used to decide whether a "sell" request already
 *  identifies a specific item or is too vague to search/list on ("a watch" vs "a Rolex"). */
export function containsKnownBrand(text: string): boolean {
  const lower = text.toLowerCase();
  return BRAND_LIST.some((b) => lower.includes(b));
}

export type PostingType = "FS" | "WTB";

/**
 * Explicit buying language ALWAYS wins, checked before FS — a post naming WTB/wanted/looking
 * for/need/buying/ISO is a buyer's request even if stock/for-sale language also appears
 * somewhere in the same message (dealer-group chatter is messy; the buyer's own signal is what
 * actually describes what they want). Absent any explicit keyword either way, a message that
 * names an actual price or reference number still classifies as FS rather than being silently
 * dropped — most unstructured trading-group chatter IS exactly this (a dealer's stock/price
 * list with no "for sale" spelled out), and genuine non-listing chatter ("hey how's it going",
 * "thanks!") never has a price or reference to trigger this fallback on.
 */
export function classifyText(text: string): PostingType | null {
  if (WTB_KEYWORDS.test(text)) return "WTB";
  if (FS_KEYWORDS.test(text)) return "FS";
  if (distinctPriceValues(text).size > 0 || extractReference(text) !== null) return "FS";
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

// This marketplace deals in listings that are effectively always >= $1,000 (rare accessories
// aside), so a bare number in that range with no explicit currency/thousands marker — "25.5" or
// "25,5" — is dealer shorthand for "25.5 thousand", the same way a trader would say "25.5k"
// out loud. Only applied when the value came from an explicit 1-2 digit decimal/comma (i.e.
// genuinely looks like intentional shorthand); a bare whole integer like "500" is left as a
// literal dollar value, since that's how a real sub-$1,000 accessory price would be written.
const LOW_VALUE_THOUSANDS_THRESHOLD = 1000;

/** Disambiguates "," / "." as a decimal point (1-2 trailing digits) vs. a thousands separator (exactly 3 trailing digits, e.g. "26,200"). */
function parseNumericToken(token: string): { value: number | null; hadShortDecimal: boolean } {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(token)) {
    const n = Number(token.replace(/[.,]/g, ""));
    return { value: Number.isFinite(n) ? n : null, hadShortDecimal: false };
  }
  const sepMatch = token.match(/^(\d+)[.,](\d+)$/);
  if (sepMatch) {
    const [, whole, frac] = sepMatch;
    if (frac.length === 3) {
      const n = Number(whole + frac); // thousands separator: "26,200" / "26.200" -> 26200
      return { value: Number.isFinite(n) ? n : null, hadShortDecimal: false };
    }
    const n = Number(`${whole}.${frac}`); // decimal point: "25.5" / "25,5" -> 25.5
    return { value: Number.isFinite(n) ? n : null, hadShortDecimal: true };
  }
  // Multiple separators that are not valid thousands grouping are not safe to reinterpret.
  const plain = Number(token.replace(/,/g, ""));
  return { value: Number.isFinite(plain) ? plain : null, hadShortDecimal: false };
}

/**
 * Normalizes dealer price shorthand to a real dollar amount: "25.5", "25,5", and "25.5k" all
 * normalize to 25500; "26,200" and "500" are left as literal amounts (26200 and 500). Only the
 * FIRST currency is used when several are mentioned together (e.g. "25,5usd/35,4cad") — never
 * averaged or guessed between them, since there's no reliable signal for which one the buyer
 * actually meant when a dealer lists both.
 */
export function normalizePriceShorthand(raw: string): number | null {
  if (!raw) return null;
  const firstSegment = raw.split("/")[0].trim();

  const kMatch = firstSegment.match(/([\d.,]+)\s*k\b/i);
  if (kMatch) {
    const base = parseNumericToken(kMatch[1]).value;
    return base === null ? null : base * 1000;
  }

  const numMatch = firstSegment.match(/[\d][\d.,]*/);
  if (!numMatch) return null;
  const { value, hadShortDecimal } = parseNumericToken(numMatch[0]);
  if (value === null) return null;

  return hadShortDecimal && value > 0 && value < LOW_VALUE_THOUSANDS_THRESHOLD ? value * 1000 : value;
}

/** The distinct normalized $-amounts named in `text` — shared by extractUnambiguousPrice (below) and hasMultipleDistinctPrices, so "how many different prices does this text mention" is computed exactly one way. */
interface PriceMention {
  amount: number;
  currency: string;
}

/** Currency derived from the SAME token that supplied the amount, never unrelated text. */
function currencyFromPriceToken(token: string): string {
  const named = token.match(/\b(USD|CAD|HKD|EUR|GBP|AED|SGD|AUD|JPY|CNY|RMB|CHF)\b/i)?.[1].toUpperCase();
  if (named) return named === "RMB" ? "CNY" : named;
  if (/US\$/i.test(token)) return "USD";
  if (/HK\$/i.test(token)) return "HKD";
  if (/C\$/i.test(token)) return "CAD";
  if (/S\$/i.test(token)) return "SGD";
  if (/A\$/i.test(token)) return "AUD";
  if (/CN¥/i.test(token)) return "CNY";
  if (/€/.test(token)) return "EUR";
  if (/£/.test(token)) return "GBP";
  if (/¥/.test(token)) return "JPY";
  return "USD";
}

function priceTokens(text: string): string[] {
  const matches = [...text.matchAll(new RegExp(PRICE_PATTERN.source, "gi"))];
  return matches
    .filter((match) => {
      const raw = match[0];
      // A watch reference followed by settlement wording is not a trailing-code price:
      // "Rolex 126333 USD wire only" states payment currency, not a USD 126,333 ask.
      if (!new RegExp(`^${NUM}\\s?${CURRENCY_CODE}\\b`, "i").test(raw)) return true;
      const index = match.index ?? 0;
      const after = text.slice(index + raw.length);
      const followedBySettlement = /^[\s,;:.()\[\]{}\-–—]*(?:wire|transfer|payment|settlement|account|accepted|only)\b/i.test(after);
      if (!followedBySettlement) return true;
      // If the text already named a watch reference before this token, this numeric token is
      // the listing price even when settlement instructions follow it. Without an earlier
      // reference, preserve the safer interpretation: the token itself is the reference.
      return REFERENCE_PATTERN.test(text.slice(0, index));
    })
    .map((match) => match[0]);
}

function priceMentions(text: string): PriceMention[] {
  return priceTokens(text)
    .map((raw) => {
      const amount = normalizePriceShorthand(raw);
      return amount === null ? null : { amount, currency: currencyFromPriceToken(raw) };
    })
    .filter((mention): mention is PriceMention => mention !== null);
}

function distinctPriceValues(text: string): Set<number> {
  return new Set(priceMentions(text).map((mention) => mention.amount));
}

function extractUnambiguousMoney(text: string): PriceMention | null {
  const mentions = priceMentions(text);
  const distinct = new Map(mentions.map((mention) => [`${mention.currency}:${mention.amount}`, mention]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

/**
 * A single, unambiguous $-amount in the text. Multiple distinct price mentions (e.g. a
 * multi-item dealer price list dumped as one message) make it impossible to know which price
 * belongs to which item, so this returns null rather than guessing by picking the first one.
 * Exported so watchfacts/api.ts can cross-check a WatchFacts "single" listing's own structured
 * `sale.price` field against what the listing's own title/description actually says — see
 * mapToInventoryListings for why the structured field alone isn't always trustworthy.
 */
export function extractUnambiguousPrice(text: string): number | null {
  return extractUnambiguousMoney(text)?.amount ?? null;
}

/**
 * True when `text` names more than one distinct $ amount — the signature of an unstructured
 * multi-item dealer price-list dump rather than one specific watch's listing text. Exported so
 * matching (matching/engine.ts) can treat such a listing as untrustworthy regardless of what its
 * OWN structured `price` field claims — a WatchFacts API "single" listing (empty `listings[]`)
 * whose title/description is itself a bundle blast never went through this ambiguity check the
 * way a chat-captured listing's price does (see normalizeText below), since its price comes
 * straight from the API's own `sale.price` field, not from re-parsing this text. Content alone
 * can still reveal the mismatch: a "single" listing whose own text names a dozen different
 * prices is never actually about one watch, no matter what its price field says.
 */
export function hasMultipleDistinctPrices(text: string): boolean {
  return distinctPriceValues(text).size > 1;
}

/** Shared by v3 (matching/engine.ts) and v4 (this file) — one reference-extraction rule, not two hand-synced copies. */
export function extractReference(text: string): string | null {
  // Remove every recognized price token before looking for a reference. A symbol-prefixed
  // amount such as "€100000" has the same numeric shape as a watch reference once the symbol is
  // ignored, so a dollar-only lookbehind cannot safely protect the newly supported currencies.
  const withoutPrices = priceTokens(text).reduce((remaining, token) => remaining.replace(token, " "), text);
  const m = withoutPrices.match(REFERENCE_PATTERN);
  return m ? m[1].toUpperCase() : null;
}

/**
 * True when two references are the same watch, allowing for a bare base reference matching a
 * variant that adds a letter/dial suffix — e.g. a search for "116500" (no suffix) must still
 * find a listing stored as "116500LN". This is a prefix check in EITHER direction, so it only
 * ever matches when one reference's digits/letters are the other's, plus more on the end — it
 * can never match two references that simply share a prefix but then diverge (normalizeReference
 * on "116508" is "116508", which does not start with "116500", so the two stay distinct).
 */
export function referencesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizeReference(a);
  const nb = normalizeReference(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

export function normalizeText(text: string): NormalizedFields {
  const lower = text.toLowerCase();
  const brand = BRAND_LIST.find((b) => lower.includes(b)) ?? "";
  const money = extractUnambiguousMoney(text);
  return {
    brand,
    reference: extractReference(text) ?? "",
    price: money?.amount ?? null,
    currency: money?.currency ?? "USD",
  };
}
