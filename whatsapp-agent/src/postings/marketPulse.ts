import { withSchema } from "./db";
import { initInventorySchema } from "../watchfacts/inventoryDb";
import { canonicalizeReference, referenceEquivalents } from "./normalize";

export interface MarketPulse {
  reference: string;
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
  if (!pulse.scope) {
    return `Market Pulse — ${title}\n\nFS: ${pulse.fsCount} active listings\nWTB: ${pulse.wtbCount} active requests\nAverage FS ask: ${average}\n\nBased on current activity across the dealer groups and WatchFacts inventory Fi monitors.`;
  }
  const counts = pulse.scope === "brand"
    ? `FS: ${pulse.fsCount} active ${title} listings\nWTB: ${pulse.wtbCount} active ${title} requests`
    : `FS: ${pulse.fsCount} active listings\nWTB: ${pulse.wtbCount} active requests`;
  const averageLine = pulse.scope === "brand" || pulse.scope === "model"
    ? "Reference-level average asking price unavailable because no reference is selected."
    : `Average FS ask: ${average}`;
  return `Market Pulse — ${title}\n\n${counts}\n${averageLine}\n\nBased on current active WatchFacts inventory and normalized listings.`;
}
