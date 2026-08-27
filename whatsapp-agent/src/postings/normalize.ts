/**
 * Deterministic, regex-based extraction — the spec allows AI to extract/normalize and
 * explain matches, but explicitly forbids AI from controlling database identity, trial
 * usage, approval state, or billing. Keeping normalization itself deterministic sidesteps
 * that risk entirely for the MVP rather than needing to firewall an AI call's output.
 */

const WTB_KEYWORDS = /\b(wtb|iso|lf|looking\s+for|in\s+search\s+of|ntq)\b/i;
const FS_KEYWORDS = /\b(fs|wts|for\s+sale|selling)\b/i;
// Trailing `\s?[kK]?` captures dealer shorthand like "$25.5k" — see normalizePriceShorthand,
// which does the actual k-multiplication; this pattern just needs to not truncate it away.
const PRICE_PATTERN = /\$\s?[\d,]+(?:\.\d+)?\s?[kK]?\b/g;
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

// This marketplace deals in listings that are effectively always >= $1,000 (rare accessories
// aside), so a bare number in that range with no explicit currency/thousands marker — "25.5" or
// "25,5" — is dealer shorthand for "25.5 thousand", the same way a trader would say "25.5k"
// out loud. Only applied when the value came from an explicit 1-2 digit decimal/comma (i.e.
// genuinely looks like intentional shorthand); a bare whole integer like "500" is left as a
// literal dollar value, since that's how a real sub-$1,000 accessory price would be written.
const LOW_VALUE_THOUSANDS_THRESHOLD = 1000;

/** Disambiguates "," / "." as a decimal point (1-2 trailing digits) vs. a thousands separator (exactly 3 trailing digits, e.g. "26,200"). */
function parseNumericToken(token: string): { value: number | null; hadShortDecimal: boolean } {
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
  // Multiple separators (e.g. "1,234,567" grouped thousands) — strip all commas and parse plain.
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

/**
 * A single, unambiguous $-amount in the text. Multiple distinct price mentions (e.g. a
 * multi-item dealer price list dumped as one message) make it impossible to know which price
 * belongs to which item, so this returns null rather than guessing by picking the first one.
 */
function extractUnambiguousPrice(text: string): number | null {
  const matches = text.match(PRICE_PATTERN);
  if (!matches) return null;
  const values = matches.map((m) => normalizePriceShorthand(m)).filter((v): v is number => v !== null);
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
  return {
    brand,
    reference: extractReference(text) ?? "",
    price: extractUnambiguousPrice(text),
    currency: "USD",
  };
}
