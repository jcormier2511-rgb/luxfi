import { withSchema } from "./db";
import { initInventorySchema } from "../watchfacts/inventoryDb";
import { canonicalizeReference, referenceEquivalents } from "./normalize";
import { convertAmount } from "../fx/convert";

/** How an average was actually arrived at, so a figure built from part of the set says so. */
export interface AverageBasis {
  /** FS listings whose price was usable and expressed in, or converted to, USD. */
  converted: number;
  /** FS listings left out: no usable price, an unknown currency, or unavailable/stale FX rates. */
  skipped: number;
}

export interface MarketPulse {
  reference: string;
  /** Exactly what the user asked for, before canonicalization — so a pulse that answered under a
   *  different reference than the one typed can say so instead of looking like the wrong watch. */
  requested?: string;
  label?: string;
  scope?: "reference" | "model" | "brand";
  fsCount: number;
  wtbCount: number;
  averageFsAsk: number | null;
  averageBasis?: AverageBasis;
}

export interface MarketScope { brand?: string; model?: string; reference?: string }

/**
 * Aggregate an exact-reference pulse from Fi's existing normalized Postgres stores.
 *
 * `postings` is the canonical group/direct monitoring store. `inventory_listings` is the
 * existing WatchFacts inventory store. WatchFacts FS rows are also mirrored into `postings`
 * for matching, so the second branch explicitly removes those mirrored identities. No raw
 * message table, CSV fallback, or channel client participates in this database-only read.
 *
 * Both sides of the union are compared on the SAME canonical identity rather than on the raw
 * stored string: each row's reference is separator-stripped and uppercased, then matched
 * against every equivalent form of the queried reference (see postings/normalize.ts's
 * explicit alias table). Without this, "116500" and "116500LN" aggregated as two different
 * watches and reported different FS/WTB counts and average asks for the same model, and a
 * stored "116508-0013" never lined up with a typed "1165080013".
 */

interface PricedRow { type: string; amount: number | null; currency: string | null }

/**
 * Averages FS asking prices in USD, converting every other currency rather than ignoring it.
 *
 * The averages used to be computed by SQL over USD rows only: a listing priced in HKD or EUR
 * counted toward the FS total but was silently dropped from the average, so the headline figure
 * described a subset without ever saying which. Conversion goes through fx/convert.ts, which
 * returns null instead of guessing when rates are missing, stale, or the currency is unknown —
 * so an unconvertible listing is reported as skipped rather than folded in at a made-up rate.
 */
async function averageFsAskInUsd(rows: PricedRow[]): Promise<{ average: number | null; basis: AverageBasis }> {
  let total = 0;
  let converted = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.type !== "FS") continue;
    if (row.amount === null || !Number.isFinite(row.amount) || row.amount <= 0) { skipped += 1; continue; }
    const currency = (row.currency || "USD").toUpperCase();
    const result = await convertAmount(row.amount, currency, "USD");
    if (!result) { skipped += 1; continue; }
    total += result.amount;
    converted += 1;
  }
  return { average: converted === 0 ? null : total / converted, basis: { converted, skipped } };
}

export async function getMarketPulse(reference: string): Promise<MarketPulse> {
  const canonicalReference = canonicalizeReference(reference);
  if (!canonicalReference) throw new Error("An exact watch reference is required");
  const equivalents = referenceEquivalents(canonicalReference);

  await initInventorySchema();
  return withSchema(async (pool) => {
    const result = await pool.query(
      `WITH current_inventory AS (
         SELECT p.type,
                CASE WHEN p.price > 0 THEN p.price::double precision END AS amount,
                COALESCE(NULLIF(p.currency,''),'USD') AS currency
         FROM postings p
         WHERE p.status='active' AND p.expires_at > now()
           AND upper(regexp_replace(COALESCE(p.reference,''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])

         UNION ALL

         SELECT i.type,
                COALESCE(i.native_price_amount,
                  CASE WHEN i.price ~ '^[[:space:]$]*[0-9][0-9,]*(\\.[0-9]+)?[[:space:]]*$'
                       THEN regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision END) AS amount,
                COALESCE(NULLIF(i.native_currency,''),'USD') AS currency
         FROM inventory_listings i
         WHERE i.is_active=TRUE AND upper(regexp_replace(COALESCE(i.ref,''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])
           AND i.type IN ('FS','WTB')
           AND NOT EXISTS (
             SELECT 1 FROM postings p
             WHERE p.source_type='api' AND p.source_platform='watchfacts_api'
               AND p.status='active' AND p.expires_at > now()
               AND p.type=i.type AND p.external_listing_id=i.external_id
           )
       )
       SELECT type, amount, currency FROM current_inventory`,
      [equivalents]
    );
    const rows = result.rows as PricedRow[];
    const { average, basis } = await averageFsAskInUsd(rows);
    return {
      reference: canonicalReference,
      requested: reference.trim().toUpperCase(),
      fsCount: rows.filter((r) => r.type === "FS").length,
      wtbCount: rows.filter((r) => r.type === "WTB").length,
      averageFsAsk: average,
      averageBasis: basis,
    };
  });
}

/** Broader identity scopes expose counts only; pricing is intentionally exact-reference only. */
export async function getScopedMarketPulse(scope: MarketScope): Promise<MarketPulse> {
  if (scope.reference) {
    const pulse = await getMarketPulse(scope.reference);
    return { ...pulse, label: [scope.brand, scope.model, pulse.reference].filter(Boolean).join(" "), scope: "reference" };
  }
  const model = scope.model?.trim();
  const brand = scope.brand?.trim();
  if (!model && !brand) throw new Error("A brand, model, or reference is required");
  const level: "model" | "brand" = model ? "model" : "brand";
  const value = (model || brand)!.toUpperCase();
  await initInventorySchema();
  return withSchema(async (pool) => {
    const postingColumn = level === "model" ? "model" : "brand";
    const inventoryColumn = level === "model" ? "item" : "brand";
    const result = await pool.query(
      `WITH scoped AS (
         SELECT p.type FROM postings p WHERE p.status='active' AND p.expires_at>now() AND upper(trim(p.${postingColumn}))=$1
         UNION ALL
         SELECT i.type FROM inventory_listings i WHERE i.is_active=TRUE AND i.type IN ('FS','WTB')
           AND upper(trim(i.${inventoryColumn}))=$1
           AND NOT EXISTS (SELECT 1 FROM postings p WHERE p.source_type='api' AND p.source_platform='watchfacts_api'
             AND p.status='active' AND p.expires_at>now() AND p.type=i.type AND p.external_listing_id=i.external_id)
       ) SELECT count(*) FILTER(WHERE type='FS')::int fs_count,
                count(*) FILTER(WHERE type='WTB')::int wtb_count FROM scoped`, [value]
    );
    return { reference: "", label: [brand, model].filter(Boolean).join(" "), scope: level,
      fsCount: Number(result.rows[0].fs_count), wtbCount: Number(result.rows[0].wtb_count), averageFsAsk: null };
  });
}


/** "Average FS ask: $63,013" plus, when some listings had to be left out, why. */
function averageLineFor(label: string, value: number | null, basis?: AverageBasis): string {
  const shown = value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  const line = `${label}: ${shown}`;
  if (!basis || basis.skipped === 0) return line;
  // Prices in other currencies are converted to USD; anything that couldn't be converted —
  // no usable price, an unknown currency, or FX rates unavailable — is named rather than
  // quietly folded into or dropped from the figure.
  return `${line}\n(from ${basis.converted} of ${basis.converted + basis.skipped} FS listings, converted to USD — ${basis.skipped} had no usable price or FX rate)`;
}

export function formatMarketPulse(pulse: MarketPulse): string {
  const title = pulse.label || pulse.reference;
  const plural = (n: number, one: string, many: string) => `${n} active ${n === 1 ? one : many}`;
  const counts = `FS: ${plural(pulse.fsCount, "listing", "listings")}\nWTB: ${plural(pulse.wtbCount, "request", "requests")}`;

  // Every pulse says what it counted. Three different questions ("this exact watch", "this
  // model", "this brand") return the same shape of numbers, and without the scope line a
  // brand-wide count reads as though it were about the one reference that was asked for.
  let scopeLine: string;
  let averageLine: string;
  if (pulse.scope === "brand") {
    scopeLine = `Scope: every ${title} listing Fi can see`;
    averageLine = "Average ask: not shown for a whole brand — ask for an exact reference.";
  } else if (pulse.scope === "model") {
    scopeLine = `Scope: every reference under ${title}`;
    averageLine = "Average ask: not shown across mixed references — ask for an exact reference.";
  } else {
    // A shorthand reference resolves to its canonical form, so a pulse asked for as "116500"
    // answers under "116500LN". Saying so is the difference between a trusted number and one
    // that looks like it came back for the wrong watch.
    const alias = pulse.requested && pulse.requested !== pulse.reference
      ? ` (${pulse.requested} and ${pulse.reference} are the same watch)`
      : "";
    scopeLine = `Scope: this exact reference${alias}`;
    averageLine = averageLineFor("Average FS ask", pulse.averageFsAsk, pulse.averageBasis);
  }

  return `Market Pulse — ${title}\n\n${scopeLine}\n${counts}\n${averageLine}\n\nBased on current WatchFacts flash-sale inventory and the dealer groups Fi monitors.`;
}


export interface NetworkMarketSnapshot { fsCount: number; wtbCount: number; averageFsAsk: number | null; averageBasis?: AverageBasis }

/**
 * The whole monitored network at once, across every reference, rather than one watch's pulse.
 *
 * Ported from codex/continue-stabilization-branch-tasks, where it was wired to "market briefing"
 * and so collided with the per-listing briefing of the same name. It earns its place at the one
 * point the per-listing briefing has nothing to say — an account with no active listings — and
 * under its own explicit command. No reference filter applies here, so unlike getMarketPulse
 * there is nothing to canonicalize; the WatchFacts mirror is still discounted exactly once.
 */
export async function getNetworkMarketSnapshot(): Promise<NetworkMarketSnapshot> {
  await initInventorySchema();
  return withSchema(async (pool) => {
    const result = await pool.query(
      `WITH current_inventory AS (
         SELECT type,
                CASE WHEN price > 0 THEN price::double precision END AS amount,
                COALESCE(NULLIF(currency,''),'USD') AS currency
         FROM postings WHERE status='active' AND expires_at > now()

         UNION ALL

         SELECT i.type,
                COALESCE(i.native_price_amount,
                  CASE WHEN i.price ~ '^[[:space:]$]*[0-9][0-9,]*(\\.[0-9]+)?[[:space:]]*$'
                       THEN regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision END) AS amount,
                COALESCE(NULLIF(i.native_currency,''),'USD') AS currency
         FROM inventory_listings i
         WHERE i.is_active=TRUE AND i.type IN ('FS','WTB')
           AND NOT EXISTS (
             SELECT 1 FROM postings p
             WHERE p.source_type='api' AND p.source_platform='watchfacts_api'
               AND p.status='active' AND p.expires_at > now()
               AND p.type=i.type AND p.external_listing_id=i.external_id
           )
       )
       SELECT type, amount, currency FROM current_inventory`
    );
    const rows = result.rows as PricedRow[];
    const { average, basis } = await averageFsAskInUsd(rows);
    return {
      fsCount: rows.filter((r) => r.type === "FS").length,
      wtbCount: rows.filter((r) => r.type === "WTB").length,
      averageFsAsk: average,
      averageBasis: basis,
    };
  });
}

export function formatNetworkMarketSnapshot(snapshot: NetworkMarketSnapshot): string {
  return `Market Overview — everything Fi is monitoring\n\nFS: ${snapshot.fsCount} active listings\nWTB: ${snapshot.wtbCount} active requests\n${averageLineFor("Average FS ask", snapshot.averageFsAsk, snapshot.averageBasis)}\n\nBased on current WatchFacts flash-sale inventory and the dealer groups Fi monitors.`;
}
