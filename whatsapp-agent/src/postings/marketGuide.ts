import { withSchema } from "./db";
import { freshInventorySql, initInventorySchema } from "../watchfacts/inventoryDb";
import { canonicalizeReference, referenceEquivalents } from "./normalize";
import { convertAmount } from "../fx/convert";

/**
 * Fi's automatic seller-facing Market Guide (spec: "FI AUTOMATIC MARKET GUIDE FOR SELLERS").
 *
 * DATA SOURCE (confirmed by inspecting the actual schema, not assumed — see db.ts/inventoryDb.ts):
 *   - `postings` (postings/db.ts): the canonical listing store — chat-originated FS/WTB AND
 *     WatchFacts-API-mirrored FS (source_type='api', source_platform='watchfacts_api'). Has
 *     real columns for dial/condition/year/box_papers/price/currency/contact_name/contact_phone/
 *     detail_url/status/expires_at. Already has a `postings_market_pulse` index built for
 *     exactly this kind of by-reference aggregation.
 *   - `inventory_listings` (watchfacts/inventoryDb.ts): the WatchFacts inventory mirror — FS AND
 *     WTB (both, via the DB-direct sync — see syncInventory.ts's syncFsFromDb/syncWtbFromDb).
 *     Has NO dial/model/year/box_papers columns (confirmed against the actual CREATE TABLE) —
 *     only brand/ref/condition (condition is empty for API-mirrored data — see
 *     fetchOpenAuctionsFromDb's hardcoded `condition: null`) plus free-text item/description.
 *     Dial/condition/year/box_papers refinement below can therefore only ever narrow the
 *     `postings`-sourced comparables; inventory_listings rows always stay in the broader,
 *     reference-level scope.
 *
 * This module reuses postings/marketPulse.ts's exact query shape (same two tables, same
 * canonical-reference matching via postings/normalize.ts, same currency-conversion via
 * fx/convert.ts, same dedup-against-the-FS-mirror NOT EXISTS clause) specifically so fsCount/
 * wtbCount come out identical to getMarketPulse for the same reference and snapshot — required
 * by spec ("Market Guide, Market Pulse, Market Briefing must report consistent FS and WTB
 * counts"). Deduplication of mirrored/repeated dealer listings (a separate concern from the
 * FS-mirror exclusion above) is applied ONLY to the pricing sample, never to fsCount/wtbCount
 * themselves — so the displayed supply/demand counts stay consistent with Market Pulse by
 * construction, while pricing statistics still can't be inflated by a repost.
 */

export type MarketPosition = "aggressively_priced" | "competitive" | "near_market" | "above_market";
export type LiquidityLabel = "strong_buyer_demand" | "balanced_market" | "buyer_selective_market";
export type MarketGuideConfidence = "none" | "low" | "moderate" | "high";

export interface MarketGuideInput {
  brand?: string;
  model?: string;
  reference: string;
  dial?: string;
  condition?: string;
  year?: string;
  boxPapers?: string;
  askingPrice?: number;
  currency?: string;
}

/** Internal auditability record — never shown to the user, kept for debugging/admin. */
export interface ComparableExclusion {
  id: string;
  reason: string;
}

export interface MarketGuideResult {
  canonicalReference: string;
  /** e.g. "116500LN — black dial" or "116500LN — all configurations". */
  scope: string;
  fsCount: number;
  wtbCount: number;
  rawSampleSize: number;
  cleanSampleSize: number;
  outliersExcluded: number;
  p25AskUsd: number | null;
  medianAskUsd: number | null;
  p75AskUsd: number | null;
  sellerAskUsd: number | null;
  marketPosition: MarketPosition | null;
  /** wtbCount / fsCount using the RAW (unfiltered) counts — supply/demand liquidity is a
   *  different question from "how many prices were usable for the range," and must never be
   *  computed off the pricing-filtered sample. Null when fsCount is 0 (nothing to divide by). */
  demandSupplyRatio: number | null;
  liquidityLabel: LiquidityLabel | null;
  confidence: MarketGuideConfidence;
  calculatedAt: string;
  comparableIdsUsed: string[];
  comparableIdsExcluded: ComparableExclusion[];
}

interface RawComparableRow {
  comparable_id: string;
  type: "FS" | "WTB";
  amount: number | null;
  currency: string | null;
  dial: string | null;
  condition: string | null;
  year: string | null;
  box_papers: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  observed_at: string | Date | null;
}

interface PricedComparable {
  id: string;
  amountUsd: number;
  dial: string | null;
  dedupeKey: string;
  observedAtMs: number;
}

const canonicalWord = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Same two-table UNION shape as postings/marketPulse.ts's getMarketPulse, extended with the
 * extra columns Market Guide needs (dial/condition/year/box_papers for comparable refinement;
 * contact_name/contact_phone/observed_at for mirrored-listing dedup) — see this file's top
 * comment for why fsCount/wtbCount computed from these rows match Market Pulse's own counts.
 */
async function fetchComparableRows(equivalents: string[]): Promise<RawComparableRow[]> {
  if (equivalents.length === 0) return [];
  await initInventorySchema();
  return withSchema(async (pool) => {
    const result = await pool.query(
      `WITH current_inventory AS (
         SELECT
           'postings:' || p.id::text AS comparable_id,
           p.type,
           CASE WHEN p.price > 0 THEN p.price::double precision END AS amount,
           COALESCE(NULLIF(p.currency,''),'USD') AS currency,
           NULLIF(p.dial,'') AS dial,
           NULLIF(p.condition,'') AS condition,
           NULLIF(p.year,'') AS year,
           NULLIF(p.box_papers,'') AS box_papers,
           NULLIF(p.contact_name,'') AS contact_name,
           NULLIF(p.contact_phone,'') AS contact_phone,
           p.created_at AS observed_at
         FROM postings p
         WHERE p.status='active' AND p.expires_at > now()
           AND upper(regexp_replace(COALESCE(p.reference,''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])

         UNION ALL

         SELECT
           'inventory:' || i.source || ':' || i.type || ':' || i.external_id AS comparable_id,
           i.type,
           COALESCE(i.native_price_amount,
             CASE WHEN i.price ~ '^[[:space:]$]*[0-9][0-9,]*(\\.[0-9]+)?[[:space:]]*$'
                  THEN regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision END) AS amount,
           COALESCE(NULLIF(i.native_currency,''),'USD') AS currency,
           NULL::text AS dial,
           NULLIF(i.condition,'') AS condition,
           NULL::text AS year,
           NULL::text AS box_papers,
           NULLIF(i.contact_name,'') AS contact_name,
           NULLIF(i.contact_phone,'') AS contact_phone,
           COALESCE(i.listed_at, i.first_seen_at) AS observed_at
         FROM inventory_listings i
         WHERE i.is_active=TRUE AND ${freshInventorySql("i")}
           AND upper(regexp_replace(COALESCE(i.ref,''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])
           AND i.type IN ('FS','WTB')
           AND NOT EXISTS (
             SELECT 1 FROM postings p
             WHERE p.source_type='api' AND p.source_platform='watchfacts_api'
               AND p.status='active' AND p.expires_at > now()
               AND p.type=i.type AND p.external_listing_id=i.external_id
           )
       )
       SELECT * FROM current_inventory`,
      [equivalents]
    );
    return result.rows as RawComparableRow[];
  });
}

/** Linear-interpolation percentile (same convention as numpy's default / Excel PERCENTILE.INC) over an ALREADY-SORTED array. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next === undefined ? sortedAsc[base] : sortedAsc[base] + rest * (next - sortedAsc[base]);
}

/**
 * Deduplicates mirrored/repeated dealer listings for PRICING purposes only (never touches
 * fsCount/wtbCount — see this file's top comment). Same seller identity (contact phone, falling
 * back to contact name) and the same rounded USD price is treated as one real listing re-posted,
 * keeping the most recently observed copy. Deliberately does NOT collapse across different
 * sellers, even at an identical price — two independent dealers pricing the same reference the
 * same way is a real, if coincidental, pair of data points, not a duplicate.
 */
function dedupeForPricing(rows: PricedComparable[]): { kept: PricedComparable[]; excluded: ComparableExclusion[] } {
  const groups = new Map<string, PricedComparable[]>();
  for (const row of rows) {
    const list = groups.get(row.dedupeKey) ?? [];
    list.push(row);
    groups.set(row.dedupeKey, list);
  }
  const kept: PricedComparable[] = [];
  const excluded: ComparableExclusion[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => b.observedAtMs - a.observedAtMs);
    kept.push(sorted[0]);
    for (const dup of sorted.slice(1)) {
      excluded.push({ id: dup.id, reason: "duplicate/mirrored listing (same seller and price)" });
    }
  }
  return { kept, excluded };
}

/**
 * IQR outlier filtering (spec-mandated deterministic method, never an LLM judgment call):
 * Q1/Q3 over the USD-normalized sample, bounds at 1.5x IQR beyond each quartile. Only ever
 * invoked for a sample of 5 or more — the 3-4 case is intentionally never IQR-filtered (spec:
 * "Do not aggressively remove observations solely because of IQR unless they also fail a
 * data-quality/sanity check" at that size — no such secondary check is implemented here, so
 * 3-4 stays as-is), and 0-2 never reaches pricing at all (see getMarketGuide).
 */
function applyOutlierFiltering(rows: PricedComparable[]): { clean: PricedComparable[]; excluded: ComparableExclusion[] } {
  const amounts = rows.map((r) => r.amountUsd).sort((a, b) => a - b);
  const q1 = quantile(amounts, 0.25);
  const q3 = quantile(amounts, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const clean: PricedComparable[] = [];
  const excluded: ComparableExclusion[] = [];
  for (const row of rows) {
    if (row.amountUsd < lowerBound || row.amountUsd > upperBound) {
      excluded.push({ id: row.id, reason: `price outlier outside IQR bounds ($${Math.round(lowerBound).toLocaleString("en-US")}–$${Math.round(upperBound).toLocaleString("en-US")})` });
    } else {
      clean.push(row);
    }
  }
  return { clean, excluded };
}

/**
 * Narrows FS comparables to the seller's own dial, when doing so still leaves enough of a
 * sample to mean anything (spec: "If only one black-dial comparable exists: fall back to
 * reference-level comparables" — never create fake precision from one or two highly filtered
 * listings). Condition/year/box_papers aren't refined on: inventory_listings has no columns for
 * them, and postings' own condition/year/box_papers data is sparse enough (chat-only) that
 * adding more refinement axes would only ever shrink an already-small sample further, without
 * the spec calling out condition/year/box_papers refinement as required (only dial's example is
 * given explicitly — "116500LN — black dial").
 */
const MIN_REFINED_COMPARABLES = 3;
function refineByDial(rows: PricedComparable[], requestedDial: string | undefined): { scoped: PricedComparable[]; scopeLabel: string } {
  const wantDial = canonicalWord(requestedDial);
  if (!wantDial || wantDial === "any" || wantDial === "either") return { scoped: rows, scopeLabel: "all configurations" };
  const matching = rows.filter((r) => r.dial && canonicalWord(r.dial) === wantDial);
  if (matching.length < MIN_REFINED_COMPARABLES) return { scoped: rows, scopeLabel: "all configurations" };
  return { scoped: matching, scopeLabel: `${requestedDial!.trim()} dial` };
}

function classifyMarketPosition(askUsd: number, p25: number, med: number, p75: number): MarketPosition {
  if (askUsd <= p25) return "aggressively_priced";
  if (askUsd <= med) return "competitive";
  if (askUsd <= p75) return "near_market";
  return "above_market";
}

/** Never claims strong liquidity from a thin sample — spec: "Do not make strong market claims
 *  from very small samples." Uses the RAW fsCount, not the pricing-filtered sample size. */
const MIN_FS_FOR_LIQUIDITY_CLAIM = 3;
function classifyLiquidity(fsCount: number, wtbCount: number): LiquidityLabel | null {
  if (fsCount < MIN_FS_FOR_LIQUIDITY_CLAIM) return null;
  const ratio = wtbCount / fsCount;
  if (ratio >= 0.5) return "strong_buyer_demand";
  if (ratio >= 0.15) return "balanced_market";
  return "buyer_selective_market";
}

export async function getMarketGuide(input: MarketGuideInput): Promise<MarketGuideResult> {
  const calculatedAt = new Date().toISOString();
  const canonicalReference = canonicalizeReference(input.reference);
  if (!canonicalReference) {
    return {
      canonicalReference: "",
      scope: "",
      fsCount: 0,
      wtbCount: 0,
      rawSampleSize: 0,
      cleanSampleSize: 0,
      outliersExcluded: 0,
      p25AskUsd: null,
      medianAskUsd: null,
      p75AskUsd: null,
      sellerAskUsd: null,
      marketPosition: null,
      demandSupplyRatio: null,
      liquidityLabel: null,
      confidence: "none",
      calculatedAt,
      comparableIdsUsed: [],
      comparableIdsExcluded: [],
    };
  }

  const equivalents = referenceEquivalents(canonicalReference);
  const rawRows = await fetchComparableRows(equivalents);

  // fsCount/wtbCount: the exact same rows Market Pulse counts, unfiltered by anything below —
  // consistency with Market Pulse/Market Briefing depends on this staying untouched.
  const fsCount = rawRows.filter((r) => r.type === "FS").length;
  const wtbCount = rawRows.filter((r) => r.type === "WTB").length;

  // Data-quality filters before pricing: only FS rows (asking prices are an FS concept), a
  // usable positive numeric amount (null/zero/negative/malformed already came back NULL from
  // the SQL above), and a currency that actually converts to USD.
  const fsRowsWithPrice = rawRows.filter((r) => r.type === "FS" && r.amount !== null && Number.isFinite(r.amount) && r.amount > 0);
  const priced: PricedComparable[] = [];
  const currencyExcluded: ComparableExclusion[] = [];
  for (const row of fsRowsWithPrice) {
    const currency = (row.currency || "USD").toUpperCase();
    const converted = await convertAmount(row.amount as number, currency, "USD");
    if (!converted) {
      currencyExcluded.push({ id: row.comparable_id, reason: `unconvertible currency (${currency})` });
      continue;
    }
    const identity = (row.contact_phone || row.contact_name || "").toLowerCase().trim();
    priced.push({
      id: row.comparable_id,
      amountUsd: converted.amount,
      dial: row.dial,
      dedupeKey: `${identity}|${Math.round(converted.amount)}`,
      observedAtMs: row.observed_at ? new Date(row.observed_at).getTime() : 0,
    });
  }

  const { scoped, scopeLabel } = refineByDial(priced, input.dial);
  const { kept: deduped, excluded: dedupExcluded } = dedupeForPricing(scoped);

  const rawSampleSize = deduped.length;
  let clean = deduped;
  let outlierExclusions: ComparableExclusion[] = [];
  // Spec: 0-2 usable prices never get a range at all; 3-4 are used as-is (no IQR); IQR applies
  // starting at 5.
  if (rawSampleSize >= 5) {
    const result = applyOutlierFiltering(deduped);
    clean = result.clean;
    outlierExclusions = result.excluded;
  }
  const cleanSampleSize = clean.length;
  // Spec: "If fewer than 3 observations remain after filtering, suppress the price guide rather
  // than displaying false precision." Only relevant once IQR has actually run (rawSampleSize>=5);
  // the 3-4 no-IQR case can never fall below its own rawSampleSize.
  const suppressPricing = rawSampleSize >= 5 && cleanSampleSize < 3;

  let p25AskUsd: number | null = null;
  let medianAskUsd: number | null = null;
  let p75AskUsd: number | null = null;
  if (rawSampleSize >= 3 && !suppressPricing) {
    const amounts = clean.map((c) => c.amountUsd).sort((a, b) => a - b);
    p25AskUsd = quantile(amounts, 0.25);
    medianAskUsd = quantile(amounts, 0.5);
    p75AskUsd = quantile(amounts, 0.75);
  }

  let sellerAskUsd: number | null = null;
  if (input.askingPrice !== undefined && Number.isFinite(input.askingPrice) && input.askingPrice > 0) {
    const currency = (input.currency || "USD").toUpperCase();
    const converted = await convertAmount(input.askingPrice, currency, "USD");
    sellerAskUsd = converted?.amount ?? null;
  }

  const marketPosition =
    sellerAskUsd !== null && p25AskUsd !== null && medianAskUsd !== null && p75AskUsd !== null
      ? classifyMarketPosition(sellerAskUsd, p25AskUsd, medianAskUsd, p75AskUsd)
      : null;

  const demandSupplyRatio = fsCount > 0 ? wtbCount / fsCount : null;
  const liquidityLabel = classifyLiquidity(fsCount, wtbCount);

  const confidence: MarketGuideConfidence = suppressPricing
    ? "low"
    : rawSampleSize >= 10
    ? "high"
    : rawSampleSize >= 5
    ? "moderate"
    : rawSampleSize >= 3
    ? "low"
    : "none";

  return {
    canonicalReference,
    scope: `${canonicalReference} — ${scopeLabel}`,
    fsCount,
    wtbCount,
    rawSampleSize,
    cleanSampleSize,
    outliersExcluded: outlierExclusions.length,
    p25AskUsd,
    medianAskUsd,
    p75AskUsd,
    sellerAskUsd,
    marketPosition,
    demandSupplyRatio,
    liquidityLabel,
    confidence,
    calculatedAt,
    comparableIdsUsed: clean.map((c) => c.id),
    comparableIdsExcluded: [...currencyExcluded, ...dedupExcluded, ...outlierExclusions],
  };
}

const MARKET_POSITION_LABEL: Record<MarketPosition, string> = {
  aggressively_priced: "Aggressively priced",
  competitive: "Competitive",
  near_market: "Near market",
  above_market: "Above market",
};

function formatUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/**
 * Conversation formatting only — every number here already comes from getMarketGuide's
 * deterministic calculation; this function makes no pricing decisions of its own. Deliberately
 * never called "valuation" — spec: use "Market Guide" or "Market Snapshot".
 */
export function formatMarketGuide(result: MarketGuideResult, sellerAsk?: { amount: number; currency: string }): string {
  const lines = ["MARKET GUIDE", ""];
  lines.push(`Current sellers: ${result.fsCount}`);
  lines.push(`Current buyers: ${result.wtbCount}`);

  if (result.rawSampleSize < 3 || result.p25AskUsd === null || result.medianAskUsd === null || result.p75AskUsd === null) {
    lines.push("Not enough current dealer listings for a reliable price range.");
  } else {
    lines.push(`Dealer asking range: ${formatUsd(result.p25AskUsd)}–${formatUsd(result.p75AskUsd)}`);
    lines.push(`Median dealer ask: ${formatUsd(result.medianAskUsd)}`);
  }

  if (sellerAsk) {
    const native = sellerAsk.currency.toUpperCase() === "USD" ? formatUsd(sellerAsk.amount) : `${sellerAsk.currency} ${Math.round(sellerAsk.amount).toLocaleString("en-US")}`;
    const usdHint = result.sellerAskUsd !== null && sellerAsk.currency.toUpperCase() !== "USD" ? ` (~${formatUsd(result.sellerAskUsd)})` : "";
    lines.push(`Your ask: ${native}${usdHint}`);
    if (result.marketPosition) lines.push(`Market position: ${MARKET_POSITION_LABEL[result.marketPosition]}`);
  }

  lines.push("");
  lines.push(
    result.wtbCount === 1
      ? "I found 1 buyer currently looking for this reference."
      : result.wtbCount > 0
      ? `I found ${result.wtbCount} buyers currently looking for this reference.`
      : "I don't see any buyers currently looking for this reference yet."
  );

  return lines.join("\n");
}
