import { config } from "../config";
import { getRates, isRatesStale } from "./rates";

export interface ConversionResult {
  amount: number;
  currency: string;
  rate: number;
  source: string;
  timestamp: string; // ISO — when the underlying rates table was fetched, not "now"
}

/**
 * Converts `amount` from `fromCurrency` to `toCurrency` using the cached rates table (see
 * fx/rates.ts — never fetches per call). Returns null — never a guessed/estimated figure —
 * when: the rates table has never been fetched, it's past FX_MAX_STALENESS_HOURS, or either
 * currency isn't in the table. Callers (matching/engine.ts) treat null the same way an
 * unparseable price is already treated everywhere else in this codebase: excluded from a hard
 * budget comparison rather than presented as a confirmed number, per Fi's price-integrity rule.
 */
export async function convertAmount(amount: number, fromCurrency: string, toCurrency: string): Promise<ConversionResult | null> {
  if (fromCurrency === toCurrency) {
    return { amount, currency: toCurrency, rate: 1, source: config.fx.provider, timestamp: new Date().toISOString() };
  }

  const table = await getRates();
  if (!table || isRatesStale()) return null;

  // Rates are relative to table.base (typically USD): rate(from->to) = rates[to] / rates[from],
  // with the base currency itself implicitly 1.
  const rateFor = (code: string): number | null => (code === table.base ? 1 : (table.rates[code] ?? null));
  const fromRate = rateFor(fromCurrency);
  const toRate = rateFor(toCurrency);
  if (fromRate === null || toRate === null) return null; // unknown currency — never guess a rate

  const rate = toRate / fromRate;
  return {
    amount: amount * rate,
    currency: toCurrency,
    rate,
    source: config.fx.provider,
    timestamp: table.fetchedAt.toISOString(),
  };
}
