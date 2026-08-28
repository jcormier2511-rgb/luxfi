import { config } from "../config";
import { normalizePriceShorthand } from "../postings/normalize";

/**
 * Display symbol per currency, matching the exact formats the buyer sees. A currency with no
 * entry here falls back to just its ISO code (e.g. "1,234 JPY") — every amount ALSO always
 * carries the trailing ISO code regardless of symbol, so the currency is never ambiguous on
 * the card even if the symbol alone would be (a bare "$" could mean several things; "$110,000
 * USD" cannot).
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  HKD: "HK$",
  SGD: "S$",
  CAD: "C$",
  AUD: "A$",
};

/**
 * Symbols tried longest-first so "HK$"/"S$"/"C$"/"A$" are recognized before the bare "$" they
 * contain. Bare "$" is deliberately excluded here and handled separately in
 * parseNativePriceToken below, resolving to config.fx.baseCurrency rather than a hardcoded
 * "USD" — it's a config-driven default assumption, not a confirmed currency read from the text.
 */
const SYMBOL_TO_CURRENCY: [symbol: string, currency: string][] = Object.entries(CURRENCY_SYMBOLS)
  .filter(([currency]) => currency !== "USD")
  .map(([currency, symbol]): [string, string] => [symbol, currency])
  .sort((a, b) => b[0].length - a[0].length);

/** Exported for conversation/flow.ts's "Show prices in <code>" / "Use <code> as my preferred
 *  currency" command — validates a user-supplied code before it's stored as a preference. */
export const CURRENCY_CODES = ["USD", "EUR", "GBP", "HKD", "SGD", "CAD", "AUD", "JPY", "CNY", "CHF", "AED"];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Must start with an actual digit — a naive `[\d,]+` also matches a BARE comma (no digits at
// all), which let a stray ", " before an unrelated currency code turn into a phantom price
// token. Requires either proper thousands-grouped digits (comma followed by exactly 3 digits,
// one or more times) or a plain unbroken digit run — never a trailing/standalone comma.
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?\\s?[kK]?";
// Bare "$" is included in the DETECTION pattern (a price is still a price even when its
// currency is ambiguous) but listed LAST, after every multi-character symbol that contains
// it — regex alternation tries left-to-right and won't re-match a span another alternative
// already consumed, so "HK$850,000" matches the "HK$" branch as one token, never leaving a
// leftover "$850,000" for the bare-$ branch to ALSO match as if it were a second, different
// price mention.
const SYMBOL_ALTERNATION = [...SYMBOL_TO_CURRENCY.map(([sym]) => escapeRegex(sym)), "\\$"].join("|");
const CODE_GROUP = CURRENCY_CODES.join("|");

const NATIVE_PRICE_PATTERN = new RegExp(
  `(?:${SYMBOL_ALTERNATION})\\s?${NUM}` + `|\\b(?:${CODE_GROUP})\\s?${NUM}\\b` + `|\\b${NUM}\\s?(?:${CODE_GROUP})\\b`,
  "gi"
);

export interface NativePrice {
  amount: number;
  /** ISO 4217 code, e.g. "HKD" — never a bare symbol. */
  currency: string;
  /** The verbatim substring this was read from, e.g. "HK$850,000". */
  originalText: string;
}

/**
 * Parses one already-isolated price-like substring (from NATIVE_PRICE_PATTERN above) into its
 * amount and currency. Symbols are checked before bare currency codes, and longer symbols
 * ("HK$") before the shorter ones they contain ("$") — see SYMBOL_TO_CURRENCY's sort above.
 * A bare "$" with no other signal is genuinely ambiguous (could be USD, or a seller writing
 * their own local currency's dollar sign without the ISO code) — for this MVP it resolves to
 * FX_BASE_CURRENCY (USD by default), the same assumption every price in this codebase has
 * always made, but never a code found in the text itself is overridden by that assumption.
 */
function parseNativePriceToken(token: string): { amount: number; currency: string } | null {
  const trimmed = token.trim();
  for (const [symbol, currency] of SYMBOL_TO_CURRENCY) {
    if (trimmed.toUpperCase().startsWith(symbol.toUpperCase())) {
      const amount = normalizePriceShorthand(trimmed.slice(symbol.length));
      return amount === null ? null : { amount, currency };
    }
  }
  if (trimmed.startsWith("$")) {
    const amount = normalizePriceShorthand(trimmed.slice(1));
    return amount === null ? null : { amount, currency: config.fx.baseCurrency };
  }
  const codeBefore = trimmed.match(new RegExp(`^(${CODE_GROUP})`, "i"));
  if (codeBefore) {
    const amount = normalizePriceShorthand(trimmed.slice(codeBefore[0].length));
    return amount === null ? null : { amount, currency: codeBefore[1].toUpperCase() };
  }
  const codeAfter = trimmed.match(new RegExp(`(${CODE_GROUP})$`, "i"));
  if (codeAfter) {
    const amount = normalizePriceShorthand(trimmed.slice(0, trimmed.length - codeAfter[0].length));
    return amount === null ? null : { amount, currency: codeAfter[1].toUpperCase() };
  }
  return null;
}

/**
 * A single, unambiguous native price+currency in `text` — same "reject rather than guess"
 * principle as postings/normalize.ts's extractUnambiguousPrice, but currency-aware. Returns
 * null when the text names more than one DISTINCT (currency, amount) pair (can't know which one
 * is the real price) or names none at all.
 */
export function extractNativePrice(text: string): NativePrice | null {
  const matches = text.match(NATIVE_PRICE_PATTERN);
  if (!matches) return null;
  const parsed = matches
    .map((raw) => {
      const p = parseNativePriceToken(raw);
      return p ? { ...p, originalText: raw.trim() } : null;
    })
    .filter((p): p is NativePrice => p !== null);
  if (parsed.length === 0) return null;
  const distinctKeys = new Set(parsed.map((p) => `${p.currency}:${p.amount}`));
  if (distinctKeys.size !== 1) return null;
  return parsed[0];
}

/**
 * "$110,000 USD" / "€95,000 EUR" / "HK$850,000 HKD" — the ISO code always trails the symbol so
 * the currency is never ambiguous on the card, even for a currency whose symbol is shared with
 * another (a bare "$" alone could be several currencies; this format never leaves it bare).
 */
export function formatCurrency(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";
  const formatted = Math.round(amount).toLocaleString("en-US");
  return `${symbol}${formatted} ${currency}`;
}
