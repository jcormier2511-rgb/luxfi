import { config } from "../config";

export interface RatesTable {
  base: string;
  /** Currency code -> rate relative to `base` (e.g. base "USD", rates.HKD ≈ 7.8). */
  rates: Record<string, number>;
  fetchedAt: Date;
}

let cached: RatesTable | null = null;
// Dedupes concurrent callers during a refresh — a burst of matches/searches arriving while a
// fetch is already in flight all await the SAME request rather than each firing their own.
let inFlight: Promise<RatesTable | null> | null = null;

/**
 * Open Exchange Rates' `/latest.json` — the complete rates table in one call. Deliberately
 * never called per-listing or per-match (see getRates below, which only re-fetches once per
 * FX_REFRESH_MINUTES) — a real feed matching against this could otherwise mean thousands of
 * FX API calls a day for no benefit, since exchange rates don't move meaningfully minute to
 * minute.
 */
async function fetchRatesFromProvider(): Promise<RatesTable | null> {
  if (!config.fx.appId) {
    console.error("[fx] OPEN_EXCHANGE_RATES_APP_ID is not set — currency conversion is inert");
    return null;
  }
  try {
    const url = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(config.fx.appId)}&base=${encodeURIComponent(
      config.fx.baseCurrency
    )}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[fx] rates request failed (${res.status}):`, await res.text().catch(() => "<no body>"));
      return null;
    }
    const body = (await res.json()) as { base?: string; rates?: Record<string, number> };
    if (!body.rates || typeof body.rates !== "object") return null;
    return { base: body.base ?? config.fx.baseCurrency, rates: body.rates, fetchedAt: new Date() };
  } catch (err) {
    console.error("[fx] rates request threw:", err);
    return null;
  }
}

/** Hours since the cached table was last successfully refreshed, or null if never fetched. */
export function getRatesAgeHours(): number | null {
  if (!cached) return null;
  return (Date.now() - cached.fetchedAt.getTime()) / (1000 * 60 * 60);
}

/** True once the cached table is older than FX_MAX_STALENESS_HOURS, or if there is none at all. */
export function isRatesStale(): boolean {
  const age = getRatesAgeHours();
  return age === null || age > config.fx.maxStalenessHours;
}

/**
 * Returns the cached rates table, refreshing it only when it's older than FX_REFRESH_MINUTES
 * (or has never been fetched). A refresh failure keeps serving the last good table — a
 * transient FX outage should degrade to "possibly a bit stale," not "conversion completely
 * broken" — until it crosses FX_MAX_STALENESS_HOURS, at which point isRatesStale() above
 * starts telling callers not to trust it.
 */
export async function getRates(): Promise<RatesTable | null> {
  const ageMinutes = cached ? (Date.now() - cached.fetchedAt.getTime()) / (1000 * 60) : Infinity;
  if (cached && ageMinutes < config.fx.refreshMinutes) return cached;

  if (!inFlight) {
    inFlight = fetchRatesFromProvider().finally(() => {
      inFlight = null;
    });
  }
  const fresh = await inFlight;
  if (fresh) cached = fresh;
  return cached;
}

/** Test-only — seeds the cache directly so conversion tests don't depend on network access. */
export function _setRatesForTests(table: RatesTable | null): void {
  cached = table;
}

/** Test-only — clears the cache and any in-flight fetch tracking between tests. */
export function _resetRatesForTests(): void {
  cached = null;
  inFlight = null;
}
