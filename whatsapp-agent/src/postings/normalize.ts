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
// Up to FOUR trailing letters: Rolex's current GMT/Daytona/Sub families end in four
// ("126710BLRO", "126711CHNR", "126720VTNR") and were not recognised as references at all with
// a three-letter cap — a dealer's "Need these three: 116500LN, 126710BLRO, 5712G" lost one.
const REFERENCE_PATTERN = /(?<!\$\s?)\b(\d{4,6}[A-Z]{0,4}(?:[-/.][A-Z0-9]+)*|\d{3}(?:\.[A-Z0-9]+){2,})\b/i;
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

/**
 * Single words that only ever carry buy/sell intent and can never identify a watch, including
 * the transposition typos people actually send ("ot" for "to", "fo" for "for").
 *
 * This is the shared vocabulary for "that phrase is intent language, not a watch". It is used
 * by conversation intake (stripping a lead-in off a message, and refusing to read a model out
 * of what's left) and by posting persistence (refusing to infer a model from the same leftover)
 * so both paths agree — the live bug that motivated it stored "ot buy a" as a Rolex's model and
 * displayed "Rolex ot buy a", and its punctuation-only leftover stored a bare ",".
 */
export const INTENT_TOKENS: ReadonlySet<string> = new Set([
  "i", "im", "i'm", "id", "i'd", "we", "we're", "am", "would", "like", "please", "pls",
  "want", "wanna", "wants", "wanting", "wanted", "need", "needs", "needed",
  "looking", "look", "seeking", "seek", "searching", "search", "hunting", "find", "get",
  "buy", "buys", "buying", "purchase", "sell", "sells", "selling", "have",
  "to", "ot", "for", "fo", "a", "an", "the", "me", "my",
  "wtb", "wts", "fs", "iso", "lf", "ntq",
]);

/**
 * Words that describe a watch but never name its model: dial colors, the nouns they attach to,
 * and condition/qualifier language. A dial color has its own slot, so letting one land in the
 * model column both loses information and invents it — the live session showed
 * "Model: black" for "WTB rolex 116500 black dial", and the same defect stored "white" for a
 * white-dial request.
 *
 * These are only ever used to judge a WHOLE phrase (see isOnlyNonModelLanguage); individual
 * words are never deleted from the middle of one, because real models are built from them —
 * Tudor's Black Bay must survive intact while a bare leftover "black" must not.
 */
const DESCRIPTOR_TOKENS: ReadonlySet<string> = new Set([
  "black", "white", "blue", "green", "silver", "champagne", "grey", "gray", "salmon", "panda",
  "dial", "dials", "color", "colour", "colors", "colours",
  "preowned", "pre", "owned", "used", "unworn", "mint", "new", "brand",
  "any", "either", "unknown", "none",
]);

/**
 * True when `phrase` names no model — it is empty, punctuation only, or made up entirely of
 * intent language and descriptors. This is the guard both the intake draft and the persisted
 * posting row use before writing a model, so neither can store a leftover that identifies
 * nothing.
 */
export function isOnlyNonModelLanguage(phrase: string): boolean {
  const tokens = phrase.toLowerCase().split(/[^a-z0-9'’]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => {
    const word = t.replace(/’/g, "'");
    return INTENT_TOKENS.has(word) || DESCRIPTOR_TOKENS.has(word);
  });
}

/**
 * True when `phrase` carries no identifying information at all — it is empty, punctuation only,
 * or made up of nothing but INTENT_TOKENS. Such a phrase must never be stored as a model.
 */
export function isOnlyIntentLanguage(phrase: string): boolean {
  const tokens = phrase.toLowerCase().split(/[^a-z0-9'’]+/).filter(Boolean);
  return tokens.length === 0 || tokens.every((t) => INTENT_TOKENS.has(t.replace(/’/g, "'")));
}

/** True when `text` names a known maker brand — used to decide whether a "sell" request already
 *  identifies a specific item or is too vague to search/list on ("a watch" vs "a Rolex"). */
export function containsKnownBrand(text: string): boolean {
  const lower = text.toLowerCase();
  return BRAND_LIST.some((b) => lower.includes(b));
}

/**
 * Splits an optional leading maker name off `text` ("Rolex 116500LN" -> brand "rolex", rest
 * "116500LN"). Longest brand first, so "patek philippe" is never truncated to "patek".
 */
export function splitLeadingBrand(text: string): { brand: string | null; rest: string } {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const brand = [...BRAND_LIST].sort((a, b) => b.length - a.length).find((b) => lower.startsWith(`${b} `) || lower === b);
  if (!brand) return { brand: null, rest: trimmed };
  return { brand, rest: trimmed.slice(brand.length).trim() };
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
      const amount = normalizePriceShorthand(raw);
      return REFERENCE_PATTERN.test(text.slice(0, index)) ||
        (amount !== null && amount >= 1000 && amount % 500 === 0);
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

/** A bare 4-digit token in the 1900-2099 range is exactly as shaped as a watch reference — the
 *  only thing that tells them apart in free text is context, and a real reference nearby in the
 *  same message is the strongest signal available. */
const BARE_YEAR = /^(?:19|20)\d{2}$/;

/** Shared by v3 (matching/engine.ts) and v4 (this file) — one reference-extraction rule, not two hand-synced copies. */
export function extractReference(text: string): string | null {
  // Remove every recognized price token before looking for a reference. A symbol-prefixed
  // amount such as "€100000" has the same numeric shape as a watch reference once the symbol is
  // ignored, so a dollar-only lookbehind cannot safely protect the newly supported currencies.
  const withoutPrices = priceTokens(text).reduce((remaining, token) => remaining.replace(token, " "), text);
  // Find every reference-shaped token rather than just the first: a stated year ("Sell my 2022
  // Rolex Daytona 116500LN...") is itself reference-shaped (4 bare digits), and matching only the
  // first occurrence silently returned "2022" as the reference — which then failed to canonicalize
  // against anything, producing wrong FS/WTB counts and a Market Guide with no data.
  const matches = [...withoutPrices.matchAll(new RegExp(REFERENCE_PATTERN.source, "gi"))];
  // A bare year immediately followed by a capitalized word ("2022 Rolex", "2022 Daytona") is
  // stated as a production year leading into the brand/model, never as the reference itself — a
  // real reference is never followed directly by a proper-noun-shaped word. Dropped from the
  // candidate pool entirely (not just deprioritized), so it can't win by default when nothing
  // else is present either ("I've got a 2022 Daytona black dial full set" names no reference at
  // all, and must not silently become one).
  const isYearBeforeProperNoun = (m: RegExpMatchArray): boolean =>
    BARE_YEAR.test(m[1]) && m.index !== undefined && /^\s+[A-Z]/.test(withoutPrices.slice(m.index + m[0].length));
  const candidates = matches.filter((m) => !isYearBeforeProperNoun(m));
  // Otherwise, a bare year-shaped token is treated as the reference only when nothing better is
  // present, since a vintage reference (e.g. Rolex 1016) can legitimately look exactly like one.
  const preferred = candidates.find((m) => !BARE_YEAR.test(m[1])) ?? candidates[0];
  return preferred ? preferred[1].toUpperCase() : null;
}

/**
 * True when two references are the same watch, allowing for a bare base reference matching a
 * variant that adds a letter/dial suffix — e.g. a search for "116500" (no suffix) must still
 * find a listing stored as "116500LN". This is a prefix check in EITHER direction, so it only
 * ever matches when one reference's digits/letters are the other's, plus more on the end — it
 * can never match two references that simply share a prefix but then diverge (normalizeReference
 * on "116508" is "116508", which does not start with "116500", so the two stay distinct).
 */
/**
 * Explicit reference aliases — the ONLY place a stored/typed reference is allowed to be treated
 * as a different string than it was written.
 *
 * Traders routinely drop a Rolex bezel/dial suffix in chat ("116500" for the ceramic Daytona),
 * which silently split the market data into two buckets: an exact `upper(trim(reference))`
 * aggregation counted "116500" and "116500LN" as two different watches, so Market Pulse and
 * Market Briefing reported different FS/WTB counts and different average asks for the same
 * model.
 *
 * The rule for adding an entry is deliberately narrow and must stay that way: a bare stem may
 * alias to a suffixed canonical reference ONLY when that stem has exactly one commercially
 * produced suffixed variant, so the shorthand cannot mean anything else. This is NOT "append LN
 * to Rolex references":
 *   - 116500 -> 116500LN  ✔  the ceramic Daytona only ever shipped as 116500LN (both the black
 *                            and the white "Panda" dial share that one reference).
 *   - 126500 -> 126500LN  ✔  its 2023 successor, likewise a single suffixed variant.
 *   - 116610 -> (none)    ✘  ambiguous: 116610LN (black) and 116610LV (green) both exist, so a
 *                            bare 116610 is genuinely undetermined and stays its own bucket.
 * Anything not listed here is left exactly as written.
 */
const REFERENCE_ALIAS_GROUPS: ReadonlyArray<{ canonical: string; aliases: readonly string[]; brand: string; model: string }> = [
  { canonical: "116500LN", aliases: ["116500"], brand: "rolex", model: "Daytona" },
  { canonical: "126500LN", aliases: ["126500"], brand: "rolex", model: "Daytona" },
];

/**
 * The maker and model a reference names on its own. Dealers routinely identify a watch by
 * reference alone ("Need a black 116500LN"), and that IS a Rolex Daytona — a request that
 * omits the words should not be recorded as brand-less. Only references with an entry above
 * are known; anything else returns null rather than a guess.
 */
export function identityForReference(reference: string): { brand: string; model: string } | null {
  const canonical = canonicalizeReference(reference);
  const group = REFERENCE_ALIAS_GROUPS.find((g) => g.canonical === canonical);
  return group ? { brand: group.brand, model: group.model } : null;
}

/** normalized alias form -> canonical display form. */
const ALIAS_TO_CANONICAL = new Map<string, string>(
  REFERENCE_ALIAS_GROUPS.flatMap((group) => [
    [normalizeReference(group.canonical), group.canonical] as const,
    ...group.aliases.map((alias) => [normalizeReference(alias), group.canonical] as const),
  ])
);

/** canonical display form -> every normalized form that means the same watch (canonical included). */
const CANONICAL_TO_EQUIVALENTS = new Map<string, string[]>(
  REFERENCE_ALIAS_GROUPS.map((group) => [
    group.canonical,
    [normalizeReference(group.canonical), ...group.aliases.map(normalizeReference)],
  ])
);

/**
 * The single display/storage form for a reference, after aliasing. Falls back to the plain
 * uppercased input (formatting preserved) when the reference has no alias entry, so an
 * unrecognized reference is never rewritten.
 */
export function canonicalizeReference(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return "";
  return ALIAS_TO_CANONICAL.get(normalizeReference(trimmed)) ?? trimmed.toUpperCase();
}

/**
 * Every normalized (separator-stripped, uppercased) form that refers to the same watch as
 * `ref` — what an aggregation must match against so a bucket can't be split by which shorthand
 * happened to be stored. Always contains at least the reference's own normalized form.
 */
export function referenceEquivalents(ref: string): string[] {
  const canonical = canonicalizeReference(ref);
  if (!canonical) return [];
  return CANONICAL_TO_EQUIVALENTS.get(canonical) ?? [normalizeReference(canonical)];
}

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
