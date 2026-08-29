import { getActiveListings } from "../watchfacts/inventoryDb";
import { InventoryListing, ItemRequest, SearchPreferences } from "../types";
import { normalizeReference, extractReference, referencesMatch, normalizePriceShorthand, hasMultipleDistinctPrices } from "../postings/normalize";
import { config, isAiMatchingEnabledForPhone } from "../config";
import { interpretQuery } from "../ai/queryInterpreter";
import { rerankCandidates } from "../ai/rerank";
import { computePriceSignal, PriceSignal } from "./priceSignal";
import { isPartsOrAccessoryListing } from "./partsFilter";
import { convertAmount } from "../fx/convert";
import { extractNativePrice, formatCurrency } from "../fx/currency";

// Shares extractReference/REFERENCE_PATTERN with postings/normalize.ts (v4) — one reference-
// extraction rule for both, not two hand-synced copies. A reference number in the free-text
// query (e.g. "buy: Rolex Daytona 116500LN") is a hard filter, not a keyword blended into
// token scoring; extractReference already excludes a $-prefixed amount ("under $20000") from
// being mistaken for one.
function extractRequestedReference(query: string): string | null {
  const ref = extractReference(query);
  return ref ? normalizeReference(ref) : null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function score(listing: InventoryListing, tokens: string[]): number {
  const haystack = tokenize(`${listing.brand} ${listing.item} ${listing.ref} ${listing.category} ${listing.description}`);
  let matches = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) matches += 1;
  }
  return matches;
}

/** Use the shared shorthand parser for stored prices such as "$110,000" or "$110k". */
function parseListingPrice(raw: string): number | undefined {
  const parsed = normalizePriceShorthand(raw);
  return parsed === null ? undefined : parsed;
}

async function normalizeBudgetPreferences(preferences?: SearchPreferences): Promise<SearchPreferences | null | undefined> {
  if (!preferences || (preferences.priceMin === undefined && preferences.priceMax === undefined)) return preferences;
  const fromCurrency = (preferences.priceCurrency || config.fx.baseCurrency).toUpperCase() === "RMB"
    ? "CNY"
    : (preferences.priceCurrency || config.fx.baseCurrency).toUpperCase();
  if (fromCurrency === config.fx.baseCurrency) return { ...preferences, priceCurrency: config.fx.baseCurrency };
  const [min, max] = await Promise.all([
    preferences.priceMin === undefined ? null : convertAmount(preferences.priceMin, fromCurrency, config.fx.baseCurrency),
    preferences.priceMax === undefined ? null : convertAmount(preferences.priceMax, fromCurrency, config.fx.baseCurrency),
  ]);
  if ((preferences.priceMin !== undefined && !min) || (preferences.priceMax !== undefined && !max)) return null;
  return {
    ...preferences,
    priceMin: min?.amount,
    priceMax: max?.amount,
    priceCurrency: config.fx.baseCurrency,
  };
}

/**
 * The amount to compare a listing's price against a stated budget (always assumed USD/
 * config.fx.baseCurrency by long-standing convention — preferences.priceMax/priceMin carry no
 * currency of their own). Prefers the listing's own native currency+amount, converted via
 * fx/convert.ts, over the plain `price` field (which this codebase has always implicitly
 * treated as already being in the base currency). Returns undefined — never a guessed number —
 * when a conversion is actually needed but unavailable (stale rates, unknown currency), same
 * "can't verify, don't assume it matches" rule as an unparseable price everywhere else.
 */
async function resolveComparablePrice(listing: InventoryListing): Promise<number | undefined> {
  const parsedNative = listing.nativeCurrency && listing.nativePriceAmount !== undefined
    ? { amount: listing.nativePriceAmount, currency: listing.nativeCurrency }
    : extractNativePrice(listing.price);
  if (parsedNative) {
    if (parsedNative.currency === config.fx.baseCurrency) return parsedNative.amount;
    const converted = await convertAmount(parsedNative.amount, parsedNative.currency, config.fx.baseCurrency);
    return converted?.amount;
  }
  return parseListingPrice(listing.price);
}

/**
 * Precomputes every candidate's comparable price ONCE per search — a currency conversion is an
 * async, cached-rate lookup, not something Array.prototype.filter/sort can await per item — so
 * the rest of the ranking pipeline below can stay synchronous, just reading from this map
 * instead of re-parsing/re-converting a price on every comparison.
 */
async function buildComparablePriceMap(listings: InventoryListing[]): Promise<Map<string, number | undefined>> {
  const entries = await Promise.all(listings.map(async (l) => [l.id, await resolveComparablePrice(l)] as const));
  return new Map(entries);
}

/**
 * True when a listing's own free text names more than one distinct $ amount — the signature of
 * an unstructured multi-item dealer price-list dump rather than one specific watch. A chat-
 * captured listing already gets this check at ingestion (normalizeText -> extractUnambiguousPrice
 * returns null, so it's never even saved as a single price). A WatchFacts API "single" listing
 * (empty listings[]) never went through that check — it trusts the API's own `sale.price` field
 * directly — so a bundle blast that the API nonetheless returned as one row would otherwise pass
 * straight through to matching with a confident-looking structured price. Excluded here,
 * regardless of what its own `price` field claims, so it can never be presented as a match for
 * one specific watch.
 */
function isUnambiguousListing(listing: InventoryListing): boolean {
  return !hasMultipleDistinctPrices(listing.description || "");
}

/** A candidate must be an actual watch, not a standalone part/accessory — see partsFilter.ts. */
function isCompleteWatchListing(listing: InventoryListing): boolean {
  return !isPartsOrAccessoryListing(listing);
}

/** True if a listing's price falls inside the preference range, or no range was set. `priceMap`
 *  is the precomputed currency-aware comparable price (see buildComparablePriceMap). */
function inPriceRange(listing: InventoryListing, preferences: SearchPreferences | undefined, priceMap: Map<string, number | undefined>): boolean {
  if (!preferences || (preferences.priceMin === undefined && preferences.priceMax === undefined)) return true;
  const price = priceMap.get(listing.id);
  if (price === undefined) return false; // "ASK"/unknown/unconvertible price can't be judged against a range
  if (preferences.priceMin !== undefined && price < preferences.priceMin) return false;
  if (preferences.priceMax !== undefined && price > preferences.priceMax) return false;
  return true;
}

/** How far outside the preferred range a listing's price sits — used to sort the fallback pool. */
function priceDistance(listing: InventoryListing, preferences: SearchPreferences | undefined, priceMap: Map<string, number | undefined>): number {
  if (!preferences || (preferences.priceMin === undefined && preferences.priceMax === undefined)) return 0;
  const price = priceMap.get(listing.id);
  if (price === undefined) return Infinity;
  if (preferences.priceMin !== undefined && price < preferences.priceMin) return preferences.priceMin - price;
  if (preferences.priceMax !== undefined && price > preferences.priceMax) return price - preferences.priceMax;
  return 0;
}

// WatchFacts only gives continent-level granularity (sale.region -> "North America"/"Asia"/
// "Europe", see watchfacts/api.ts) — there is no country field to check "US" against directly.
// A buyer who says "USA"/"US"/"United States" means that broad region, so those all normalize
// to the same bucket as the stored "North America" value. This is a real limitation of the
// data, not a design choice: a stated "US only" can only be enforced at the North America vs.
// rest-of-world level — it cannot distinguish a US listing from a Canadian one, since WatchFacts
// doesn't expose that distinction. Getting the real API contract (see ongoing discussion) could
// resolve this if a finer-grained field actually exists.
const REGION_ALIASES: Record<string, string> = {
  usa: "north america",
  us: "north america",
  "u.s.": "north america",
  "u.s.a.": "north america",
  "united states": "north america",
  america: "north america",
  canada: "north america",
  uk: "europe",
  "united kingdom": "europe",
  england: "europe",
  eu: "europe",
  "hong kong": "asia",
  hk: "asia",
  singapore: "asia",
};

function canonicalRegion(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return REGION_ALIASES[normalized] ?? normalized;
}

/**
 * True when a stated location and a listing's own location field refer to the same place —
 * either literally (a substring match either direction, so a precise value like a city still
 * matches) or via the region-alias bucket above, for the broad-region case ("USA" vs. the
 * stored "North America").
 */
function locationsMatch(requested: string, actual: string): boolean {
  const r = requested.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (!r || !a) return false;
  if (a.includes(r) || r.includes(a)) return true;
  return canonicalRegion(r) === canonicalRegion(a);
}

/**
 * A stated location is a MANDATORY pre-filter, same principle as price: "US only" must exclude
 * a Hong Kong listing outright, not just rank it lower. A listing with no location on file
 * can't be verified against a stated requirement, so it's excluded too — never assumed to match.
 */
function matchesLocation(listing: InventoryListing, preferences?: SearchPreferences): boolean {
  if (!preferences?.location) return true; // no stated requirement — nothing to exclude on
  if (!listing.location) return false; // can't verify an unstated location against a stated one
  return locationsMatch(preferences.location, listing.location);
}

/** Dial/condition are freeform text, so they nudge sort order rather than hard-exclude — unlike
 *  location (see matchesLocation above), which is now a mandatory pre-filter. */
function softPreferenceScore(listing: InventoryListing, preferences?: SearchPreferences): number {
  if (!preferences) return 0;
  let s = 0;
  const haystack = `${listing.description} ${listing.item}`.toLowerCase();
  if (preferences.dialColor && haystack.includes(preferences.dialColor)) s += 1;
  if (preferences.condition && listing.condition.toLowerCase().includes(preferences.condition)) s += 1;
  return s;
}

/**
 * A buyer's request ("buy") matches against FS (for sale) listings;
 * a seller's request ("sell") matches against WTB (want to buy) listings.
 * `preferences` (price/location/dial/condition, collected once per contact) applies price AND
 * location as MANDATORY pre-filters, before any ranking — a listing outside the stated budget
 * or outside the stated location is excluded outright, never shown anyway just to have something
 * to display. Dial/condition nudge sort order for the freeform fields instead of hard-excluding,
 * since those are much fuzzier to match on exact text.
 *
 * When the query names a specific reference number, that's a hard filter: only listings whose
 * own `ref` normalizes to an exact match are ever returned — never falling back to keyword
 * overlap or (if nothing matches, or nothing in that price range) the "show something anyway"
 * pool. A reference search is a request for THAT watch, not something similar; an empty result
 * here is exactly what should happen, and the caller (flow.ts) already turns zero matches into
 * "I'll keep watching the network" rather than silence.
 */
export async function findMatches(request: ItemRequest, limit: number, preferences?: SearchPreferences): Promise<InventoryListing[]> {
  const wantType = request.action === "buy" ? "FS" : "WTB";
  // Excludes multi-item price-list dumps and standalone part/accessory listings before they
  // ever reach the reference/token branches below — see isUnambiguousListing/isCompleteWatchListing.
  const candidates = (await getActiveListings(wantType)).filter(isUnambiguousListing).filter(isCompleteWatchListing);
  const normalizedPreferences = await normalizeBudgetPreferences(preferences);
  if (normalizedPreferences === null) return [];
  preferences = normalizedPreferences;
  // Currency-aware, precomputed once for the whole candidate pool — see buildComparablePriceMap.
  const priceMap = await buildComparablePriceMap(candidates);
  const requestedRef = extractRequestedReference(request.query);

  if (requestedRef) {
    const exact = candidates.filter((l) => l.ref && referencesMatch(l.ref, requestedRef));
    // No price/location-ignoring fallback: a listing over budget or outside the stated location
    // is excluded, period — showing it anyway "so there's something to display" is worse than
    // truthfully showing nothing.
    const pool = exact.filter((l) => inPriceRange(l, preferences, priceMap) && matchesLocation(l, preferences));
    const ranked = pool
      .map((listing) => ({
        listing,
        prefScore: softPreferenceScore(listing, preferences),
        priceDist: priceDistance(listing, preferences, priceMap),
      }))
      .sort(
        (a, b) =>
          b.prefScore - a.prefScore || a.priceDist - b.priceDist || Number(b.listing.rating) - Number(a.listing.rating)
      );
    return ranked.slice(0, limit).map((r) => r.listing);
  }

  const tokens = tokenize(request.query);
  // Same mandatory price/location pre-filter as the reference branch above — a hard budget or
  // location is never relaxed just because nothing else in the broader pool happens to fit it.
  const pool = candidates.filter((l) => inPriceRange(l, preferences, priceMap) && matchesLocation(l, preferences));

  const ranked = pool
    .map((listing) => ({
      listing,
      tokenScore: score(listing, tokens),
      prefScore: softPreferenceScore(listing, preferences),
      priceDist: priceDistance(listing, preferences, priceMap),
    }))
    .sort(
      (a, b) =>
        b.tokenScore - a.tokenScore ||
        b.prefScore - a.prefScore ||
        a.priceDist - b.priceDist ||
        Number(b.listing.rating) - Number(a.listing.rating)
    );

  // No token overlap — fall back to the full ranked pool (still price/pref/rating sorted)
  // so the trial always demonstrates value instead of returning nothing.
  const withTokenMatch = ranked.filter((r) => r.tokenScore > 0);
  const finalPool = withTokenMatch.length > 0 ? withTokenMatch : ranked;

  return finalPool.slice(0, limit).map((r) => r.listing);
}

/** Native + (optionally) converted display strings for one listing's price — see fx/. */
export interface CurrencyDisplay {
  /** e.g. "HK$850,000 HKD" — the listing's own stated price, always shown as-is, never overwritten. */
  native: string;
  /** e.g. "$109,100 USD" — present only when conversion to the base/display currency succeeded. */
  converted?: string;
  /** True when conversion was needed (native currency differs from the base currency) but
   *  couldn't be confirmed (stale rates, unknown currency) — shows a caveat instead of a number. */
  unavailable?: boolean;
}

export interface MatchResult {
  listing: InventoryListing;
  /** Set only on a hybrid/AI-assisted pick — an explanation grounded in that listing's own text. */
  explanation?: string;
  /** Set by attachPriceSignals (called from flow.ts) — see priceSignal.ts. FS results only. */
  priceSignal?: PriceSignal;
  /** Set by attachCurrencyDisplay (called from flow.ts) — see fx/. Undefined for a listing with no known native currency (falls back to the plain price line, exactly as before this feature). */
  currencyDisplay?: CurrencyDisplay;
}

/**
 * Attaches a comps-based price signal (see priceSignal.ts) to each FS result. Fetches the
 * active-FS-listings comp pool once per call (not once per result) — a no-op, no extra query,
 * when there's no FS result to signal. WTB results are left unsignaled: comps here are other
 * dealers' asking prices, which isn't the right comparison for a buyer's stated max bid.
 */
export async function attachPriceSignals(results: MatchResult[]): Promise<MatchResult[]> {
  if (!results.some((r) => r.listing.type === "FS")) return results;
  const normalizedResults = await Promise.all(results.map(async (r) => ({
    ...r.listing,
    priceUsd: await resolveComparablePrice(r.listing),
  })));
  const comparablePool = await Promise.all((await getActiveListings("FS")).map(async (listing) => ({
    ...listing,
    priceUsd: await resolveComparablePrice(listing),
  })));
  return results.map((r, index) => {
    const listing = normalizedResults[index];
    return listing.type === "FS"
      ? { ...r, listing, priceSignal: computePriceSignal(listing, comparablePool) ?? undefined }
      : { ...r, listing };
  });
}

/** Undefined when the listing has no known native currency at all (falls back to the plain
 *  price line, exactly as before this feature existed). `displayCurrency` defaults to the
 *  config-wide DEFAULT_DISPLAY_CURRENCY, but a contact's own "Show prices in EUR" preference
 *  (conversation/flow.ts) overrides it — this only affects the DISPLAYED estimate, never the
 *  USD-budget comparison in resolveComparablePrice above, which always targets FX_BASE_CURRENCY
 *  by the same long-standing convention priceMax/priceMin already rely on. */
async function buildCurrencyDisplay(
  listing: InventoryListing,
  displayCurrency: string = config.fx.defaultDisplayCurrency
): Promise<CurrencyDisplay | undefined> {
  const parsedNative = listing.nativeCurrency && listing.nativePriceAmount !== undefined
    ? { amount: listing.nativePriceAmount, currency: listing.nativeCurrency }
    : extractNativePrice(listing.price);
  if (!parsedNative) return undefined;
  const native = formatCurrency(parsedNative.amount, parsedNative.currency);
  if (parsedNative.currency === displayCurrency) return { native };
  const converted = await convertAmount(parsedNative.amount, parsedNative.currency, displayCurrency);
  if (!converted) return { native, unavailable: true };
  return { native, converted: formatCurrency(converted.amount, converted.currency) };
}

/**
 * Attaches currency display info (native + converted, or an "unavailable" flag when conversion
 * couldn't be confirmed) to every result — see fx/. A no-op (undefined) for a listing with no
 * known native currency, so a listing this feature has no data for renders exactly as it always
 * has (formatMatchCard's plain `$${listing.price}` line).
 */
export async function attachCurrencyDisplay(results: MatchResult[], displayCurrency?: string): Promise<MatchResult[]> {
  return Promise.all(results.map(async (r) => ({ ...r, currencyDisplay: await buildCurrencyDisplay(r.listing, displayCurrency) })));
}

/**
 * AI-assisted matching path — off by default (ENABLE_AI_MATCHING=false) and, even when
 * enabled, active only for `AI_MATCHING_TEST_PHONE` (see config.isAiMatchingEnabledForPhone).
 * Every other contact — and this contact whenever any AI call fails — gets the plain
 * deterministic findMatches() above, unchanged.
 *
 * AI only ever narrows/explains a pool that deterministic rules have already made safe:
 * candidates come from the same getActiveListings(wantType) as findMatches (active, correct
 * side only, never an inactive row); any candidate whose OWN reference explicitly conflicts
 * with the requested one is excluded BEFORE AI ever sees the pool (referencesMatch) and
 * re-checked again AFTER AI ranks it — this is the one rule AI is never allowed to override,
 * so a wrong AI pick still can't surface a 116508 for a 116500 request. A hard price ceiling and
 * a stated location requirement are applied the same way, both before and after. Nothing about
 * approval/trial/entitlement/billing/ledger state is touched here — this function only decides which listings to show;
 * flow.ts's existing approve/pass handling is completely unaffected either way.
 */
export async function findMatchesHybrid(phone: string, request: ItemRequest, limit: number, preferences?: SearchPreferences): Promise<MatchResult[]> {
  if (!isAiMatchingEnabledForPhone(phone)) {
    return (await findMatches(request, limit, preferences)).map((listing) => ({ listing }));
  }

  const interpreted = await interpretQuery(request.query);
  if (!interpreted) {
    return (await findMatches(request, limit, preferences)).map((listing) => ({ listing }));
  }

  const wantType = interpreted.action === "buy" ? "FS" : "WTB";
  // Excludes multi-item price-list dumps and standalone part/accessory listings before AI ever
  // sees the pool — see isUnambiguousListing/isCompleteWatchListing.
  const rawCandidates = (await getActiveListings(wantType)).filter(isUnambiguousListing).filter(isCompleteWatchListing);
  // The reference safety gate below must never depend solely on the AI correctly parsing the
  // reference out of the message — if interpretQuery's own extraction misses/garbles it (a real
  // model failure mode, not hypothetical), falling back to null here would let EVERY listing
  // through the eligible filter, leaving relevance entirely up to the AI reranker's judgment.
  // extractRequestedReference is the same deterministic regex-based extractor the plain
  // findMatches() path already relies on — reused here as a backstop, never a replacement.
  const rawPreferences: SearchPreferences = {
    ...preferences,
    priceMax: interpreted.maxPrice ?? preferences?.priceMax,
    priceCurrency: interpreted.currency ?? preferences?.priceCurrency,
  };
  const normalizedPreferences = await normalizeBudgetPreferences(rawPreferences);
  if (normalizedPreferences === null) return [];
  const candidates = rawCandidates;
  const requestedFamily = interpreted.referenceFamily
    ? normalizeReference(interpreted.referenceFamily)
    : extractRequestedReference(request.query);

  // Deterministic exclusion, same rule findMatches uses: a candidate WITH its own reference
  // that explicitly conflicts with the requested one is never eligible, regardless of what an
  // AI reranker might otherwise say about it.
  const eligible = candidates.filter((l) => !requestedFamily || !l.ref || referencesMatch(l.ref, requestedFamily));

  // Mandatory pre-filter, same as findMatches — a stated hard maximum is never relaxed, and
  // never applied only "if something would otherwise be left." A listing whose price is
  // missing/ambiguous (ASK, or unparseable) is excluded when a ceiling is stated, rather than
  // presented as a confirmed match with an unverified price.
  const priceCeiling = normalizedPreferences?.priceMax;
  // Same mandatory-location principle as findMatches (see matchesLocation) — a stated "US only"
  // is never relaxed just because the AI's own pool happens to be thin without it.
  const requestedLocation = interpreted.location ?? preferences?.location;
  // Currency-aware, precomputed once for the eligible pool — see buildComparablePriceMap.
  const priceMap = await buildComparablePriceMap(eligible);
  const withinBudget = eligible.filter((l) => {
    if (priceCeiling !== undefined && priceCeiling !== null) {
      const price = priceMap.get(l.id);
      if (price === undefined || price > priceCeiling) return false;
    }
    if (requestedLocation && !matchesLocation(l, { location: requestedLocation })) return false;
    return true;
  });

  // No arbitrary fallback pool here: a listing over budget, or one AI can't verify against the
  // stated budget, is excluded outright — showing it anyway "so there's something to display"
  // is exactly the failure mode this whole rework exists to remove.
  const pool = withinBudget.slice(0, 25); // cap what's sent to the model

  const picks = await rerankCandidates(interpreted, pool);
  if (picks === null) {
    // The AI call itself failed — not "found nothing" — so fall back rather than show nothing.
    return (await findMatches(request, limit, preferences)).map((listing) => ({ listing }));
  }

  // Built from `withinBudget`/`eligible`-filtered data, not the broader unfiltered `candidates`
  // — a pick whose id somehow isn't in this map (an over-budget or reference-conflicting
  // listing) is silently dropped below, never resurfaced.
  const byId = new Map(withinBudget.map((l) => [l.id, l] as const));
  const results: MatchResult[] = [];
  for (const pick of picks) {
    const listing = byId.get(pick.id);
    if (!listing) continue; // re-verified against the safety-gated pool, not just what was sent to AI
    if (requestedFamily && listing.ref && !referencesMatch(listing.ref, requestedFamily)) continue; // belt & suspenders
    if (priceCeiling !== undefined && priceCeiling !== null) {
      const price = priceMap.get(listing.id);
      if (price === undefined || price > priceCeiling) continue; // belt & suspenders — never surface an over-budget or unverifiable/unconvertible price under a stated ceiling
    }
    if (requestedLocation && !matchesLocation(listing, { location: requestedLocation })) continue; // belt & suspenders — never surface a listing outside a stated location requirement
    results.push({ listing, explanation: pick.explanation });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * A short, clean title for the "Watch:" line — never the raw original listing text. That text
 * (the actual dealer message, or the WatchFacts listing's own description) has its own always-
 * present "Description:" line in formatMatchCard below, so the two are never conflated: one is
 * a normalized title, the other is a verbatim source quote, and a reader can tell which is
 * which instead of the card's "watch" price/details being ambiguous between the two.
 */
function watchName(listing: InventoryListing): string {
  return listing.item.toLowerCase().startsWith(listing.brand.toLowerCase())
    ? listing.item
    : `${listing.brand} ${listing.item}`.trim();
}

/**
 * Fi Conversation Flow Spec (v3) §2 Match Card — counterparty name and watch details are
 * shown up front (no separate anonymized/reveal step); "approve"/"pass" is what's metered
 * against the trial, and approving is what additionally surfaces the phone number.
 * "Fi Intelligence" (dealer reputation, market range, authenticity) is still omitted — no
 * data source for those exists in the pipeline yet. The price signal (Attractive/Fair/High,
 * see priceSignal.ts) is the one piece that now does: comps come from other active WatchFacts
 * FS listings for the same reference already in this app's own inventory, no external source.
 */
function sourceLabel(listing: InventoryListing): string {
  if (listing.source === "WF") return "WatchFacts";
  if (listing.source === "WA-DM") return "Private Seller";
  return listing.source || "Unknown";
}

/** "105000" -> "$105,000" — a stored price is a plain digit string with no thousands grouping
 *  (see normalizePriceShorthand's own output), so display formatting happens here, once, rather
 *  than at every call site. Falls back to the raw string for a non-numeric value rather than
 *  showing "$NaN" — that should never happen for a real stored price, but this is a display
 *  function, not a validator. */
function formatPrice(price: string): string {
  const n = Number(price);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : `$${price}`;
}

export function formatMatchCard(
  listing: InventoryListing,
  index: number,
  action: ItemRequest["action"],
  explanation?: string,
  priceSignal?: PriceSignal,
  currencyDisplay?: CurrencyDisplay
): string {
  const roleLabel = action === "buy" ? "Seller" : "Buyer";
  const priceLabel = action === "buy" ? "Asking" : "Bid";
  // The listing's own native price string ("HK$850,000 HKD") when currency info is known —
  // never overwritten by a converted value; falls back to the plain price field exactly as
  // before this feature existed when there's no currency info to work with at all.
  const priceText = currencyDisplay ? currencyDisplay.native : listing.price === "ASK" ? "price on ask" : formatPrice(listing.price);
  const watchLine = listing.ref ? `${watchName(listing)} (Ref. ${listing.ref})` : watchName(listing);
  const lines = [
    `Potential Match #${index + 1}`,
    `${roleLabel}: ${listing.contactName || "Unnamed"}`,
    `Watch: ${watchLine}`,
    `${priceLabel}: ${priceText}${priceSignal ? ` (${priceSignal} vs. comps)` : ""}`,
  ];
  // A converted estimate is always labeled as such — it excludes shipping/fees/duties/taxes,
  // and is never presented as a confirmed budget match on its own (the actual budget-ceiling
  // enforcement already happened upstream in findMatchesHybrid/findMatches using this same
  // converted figure — this line is purely informational). When conversion was needed but
  // couldn't be confirmed (stale rates, unknown currency), the caveat replaces the estimate
  // rather than showing a stale/guessed number.
  if (currencyDisplay?.converted) {
    lines.push(`Approximately: ${currencyDisplay.converted} (estimate — excludes shipping, fees, duties, and taxes)`);
  } else if (currencyDisplay?.unavailable) {
    lines.push("Currency conversion temporarily unavailable.");
  }
  lines.push(
    `Location: ${listing.location || "Not specified"}`,
    `Source: ${sourceLabel(listing)}`,
    // Always present, distinct from the normalized "Watch:" title above — the verbatim
    // stored source text (the dealer's own message, or the WatchFacts listing's own
    // description), so a reader can see exactly what the seller/buyer actually wrote.
    `Description: ${listing.description || "Not provided"}`,
    listing.imageUrl ? `Photo: ${listing.imageUrl}` : "Photos: Not provided."
  );
  if (listing.detailUrl) lines.push(`Listing: ${listing.detailUrl}`);
  if (explanation) lines.push(`Why: ${explanation}`);
  // "photos <n>" is only meaningful on an FS/seller card — there's a seller on the other end to
  // privately ask. A "sell" card (showing a WTB buyer) keeps the original two-option footer.
  lines.push(
    action === "buy"
      ? 'Reply "approve <number>" to connect,\n"photos <number>" to request photos,\nor "pass <number>" to skip.'
      : 'Reply "approve <number>" to connect, or "pass <number>" to skip.'
  );
  return lines.join("\n");
}

/** Sent after "approve <n>" — adds the phone number so the two sides can actually connect. */
export function formatMatchApproved(listing: InventoryListing, index: number): string {
  return `Approved #${index + 1} — connecting you with ${listing.contactName || "them"}: ${listing.contactPhone}`;
}
