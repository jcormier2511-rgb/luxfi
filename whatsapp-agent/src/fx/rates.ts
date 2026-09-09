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

// Real reported bug: this fetch had no timeout. getRates() below dedupes concurrent callers into
// one shared `inFlight` promise -- if that one fetch stalls (a dropped connection that never
// resets, not an error), every phone whose message happens to need currency conversion during
// that refresh window blocks behind the same unresolved promise, on top of each phone's own
// per-phone message queue (conversation/flow.ts's withPhoneSerialized) never getting a chance to
// move on. A generous but bounded timeout lets the existing "keep serving the last good table on
// a refresh failure" fallback fire instead of hanging indefinitely.
const FX_TIMEOUT_MS = 10_000;

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
    const res = await fetch(url, { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
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

export interface FxHealthResult {
  configured: boolean;
  hasCachedRates: boolean;
  ratesAgeHours: number | null;
  stale: boolean;
  baseCurrency: string | null;
  ratesCount: number;
}

/**
 * Admin-panel visibility into whether currency conversion actually works right now. Real reported
 * bug: OPEN_EXCHANGE_RATES_APP_ID was never set on Railway, so every non-USD listing silently
 * failed to convert (convertAmount returning null looks identical to "unknown currency" from the
 * outside) — Market Pulse/Guide averages quietly excluded the vast majority of a reference's
 * listings for weeks with no error anywhere a human would see it. Calling getRates() here (rather
 * than just inspecting the cache) also means loading /admin/tools doubles as a live check of the
 * configured app id, on the same refresh cadence getRates() already enforces elsewhere.
 */
export async function getFxHealth(): Promise<FxHealthResult> {
  const configured = Boolean(config.fx.appId);
  const table = configured ? await getRates() : null;
  return {
    configured,
    hasCachedRates: table !== null,
    ratesAgeHours: getRatesAgeHours(),
    stale: isRatesStale(),
    baseCurrency: table?.base ?? null,
    ratesCount: table ? Object.keys(table.rates).length : 0,
  };
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
