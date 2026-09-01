import { withSchema } from "./db";
import { initInventorySchema } from "../watchfacts/inventoryDb";

export interface MarketPulse {
  reference: string;
  fsCount: number;
  wtbCount: number;
  averageFsAsk: number | null;
}

/**
 * Aggregate an exact-reference pulse from Fi's existing normalized Postgres stores.
 *
 * `postings` is the canonical group/direct monitoring store. `inventory_listings` is the
 * existing WatchFacts inventory store. WatchFacts FS rows are also mirrored into `postings`
 * for matching, so the second branch explicitly removes those mirrored identities. No raw
 * message table, CSV fallback, or channel client participates in this database-only read.
 */
export async function getMarketPulse(reference: string): Promise<MarketPulse> {
  const normalizedReference = reference.trim().toUpperCase();
  if (!normalizedReference) throw new Error("An exact watch reference is required");

  await initInventorySchema();
  return withSchema(async (pool) => {
    const result = await pool.query(
      `WITH current_inventory AS (
         SELECT p.type,
                CASE WHEN p.type='FS' AND upper(COALESCE(p.currency,'USD'))='USD'
                          AND p.price > 0 THEN p.price::numeric END AS fs_price
         FROM postings p
         WHERE p.status='active' AND p.expires_at > now()
           AND upper(trim(p.reference))=$1

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
         WHERE i.is_active=TRUE AND upper(trim(i.ref))=$1
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
      [normalizedReference]
    );
    const row = result.rows[0];
    return {
      reference: normalizedReference,
      fsCount: Number(row.fs_count),
      wtbCount: Number(row.wtb_count),
      averageFsAsk: row.average_fs_ask === null ? null : Number(row.average_fs_ask),
    };
  });
}

export function formatMarketPulse(pulse: MarketPulse): string {
  const average = pulse.averageFsAsk === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pulse.averageFsAsk);
  return `Market Pulse — ${pulse.reference}\n\nFS: ${pulse.fsCount} active listings\nWTB: ${pulse.wtbCount} active requests\nAverage FS ask: ${average}\n\nBased on current activity across the dealer groups and WatchFacts inventory Fi monitors.`;
}
