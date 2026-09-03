import { withSchema } from "./db";
import { initInventorySchema } from "../watchfacts/inventoryDb";
import { canonicalizeReference, referenceEquivalents } from "./normalize";

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
export async function getMarketPulse(reference: string): Promise<MarketPulse> {
  const canonicalReference = canonicalizeReference(reference);
  if (!canonicalReference) throw new Error("An exact watch reference is required");
  const equivalents = referenceEquivalents(canonicalReference);

  await initInventorySchema();
  return withSchema(async (pool) => {
    const result = await pool.query(
      `WITH current_inventory AS (
         SELECT p.type,
                CASE WHEN p.type='FS' AND upper(COALESCE(p.currency,'USD'))='USD'
                          AND p.price > 0 THEN p.price::numeric END AS fs_price
         FROM postings p
         WHERE p.status='active' AND p.expires_at > now()
           AND upper(regexp_replace(COALESCE(p.reference,''), '[^A-Za-z0-9]', '', 'g')) = ANY($1::text[])

         UNION ALL

         SELECT i.type,
                CASE WHEN i.type='FS'
                          AND upper(COALESCE(NULLIF(i.native_currency,''),'USD'))='USD'
                          AND COALESCE(i.native_price_amount,
                            CASE WHEN i.price ~ '^[[:space:]$]*[0-9][0-9,]*(\\.[0-9]+)?[[:space:]]*$'
                                 THEN regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision END) > 0
                     THEN COALESCE(i.native_price_amount,
                            regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision)::numeric END
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
       SELECT count(*) FILTER (WHERE type='FS')::int AS fs_count,
              count(*) FILTER (WHERE type='WTB')::int AS wtb_count,
              avg(fs_price) FILTER (WHERE type='FS') AS average_fs_ask
       FROM current_inventory`,
      [equivalents]
    );
    const row = result.rows[0];
    return {
      reference: canonicalReference,
      requested: reference.trim().toUpperCase(),
      fsCount: Number(row.fs_count),
      wtbCount: Number(row.wtb_count),
      averageFsAsk: row.average_fs_ask === null ? null : Number(row.average_fs_ask),
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

export function formatMarketPulse(pulse: MarketPulse): string {
  const average = pulse.averageFsAsk === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pulse.averageFsAsk);
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
    averageLine = `Average FS ask: ${average}`;
  }

  return `Market Pulse — ${title}\n\n${scopeLine}\n${counts}\n${averageLine}\n\nBased on current WatchFacts flash-sale inventory and the dealer groups Fi monitors.`;
}


export interface NetworkMarketSnapshot { fsCount: number; wtbCount: number; averageFsAsk: number | null }

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
                CASE WHEN type='FS' AND upper(COALESCE(currency,'USD'))='USD' AND price > 0
                     THEN price::numeric END AS fs_price
         FROM postings WHERE status='active' AND expires_at > now()

         UNION ALL

         SELECT i.type,
                CASE WHEN i.type='FS'
                          AND upper(COALESCE(NULLIF(i.native_currency,''),'USD'))='USD'
                          AND COALESCE(i.native_price_amount,
                            CASE WHEN i.price ~ '^[[:space:]$]*[0-9][0-9,]*(\\.[0-9]+)?[[:space:]]*$'
                                 THEN regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision END) > 0
                     THEN COALESCE(i.native_price_amount,
                            regexp_replace(i.price, '[^0-9.]', '', 'g')::double precision)::numeric END
         FROM inventory_listings i
         WHERE i.is_active=TRUE AND i.type IN ('FS','WTB')
           AND NOT EXISTS (
             SELECT 1 FROM postings p
             WHERE p.source_type='api' AND p.source_platform='watchfacts_api'
               AND p.status='active' AND p.expires_at > now()
               AND p.type=i.type AND p.external_listing_id=i.external_id
           )
       )
       SELECT count(*) FILTER (WHERE type='FS')::int AS fs_count,
              count(*) FILTER (WHERE type='WTB')::int AS wtb_count,
              avg(fs_price) FILTER (WHERE type='FS') AS average_fs_ask
       FROM current_inventory`
    );
    const row = result.rows[0];
    return {
      fsCount: Number(row.fs_count),
      wtbCount: Number(row.wtb_count),
      averageFsAsk: row.average_fs_ask === null ? null : Number(row.average_fs_ask),
    };
  });
}

export function formatNetworkMarketSnapshot(snapshot: NetworkMarketSnapshot): string {
  const average = snapshot.averageFsAsk === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(snapshot.averageFsAsk);
  return `Market Overview — everything Fi is monitoring\n\nFS: ${snapshot.fsCount} active listings\nWTB: ${snapshot.wtbCount} active requests\nAverage FS ask: ${average}\n\nBased on current activity across the dealer groups and WatchFacts inventory Fi monitors.`;
}
