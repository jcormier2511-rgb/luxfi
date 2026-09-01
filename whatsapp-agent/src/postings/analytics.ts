import { withSchema } from "./db";

export type SearchAction = "buy" | "sell";

/**
 * Best-effort logging of a resolved buy/sell search, for the admin dashboard's "top requests"
 * metric (see admin/metrics.ts). A logging failure must never block the actual search this
 * accompanies (see conversation/flow.ts's startSearch, the sole call site).
 */
export async function logSearchRequest(phone: string, action: SearchAction, query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    await withSchema((pool) => pool.query(`INSERT INTO search_requests (phone, action, query) VALUES ($1, $2, $3)`, [phone, action, trimmed]));
  } catch (err) {
    console.error("[analytics] failed to log search request:", err);
  }
}

export interface TopRequest {
  query: string;
  count: number;
}

/**
 * Most common search terms in the last `sinceDays` days, grouped case/whitespace-insensitively.
 * The most recently seen raw casing/phrasing is used as the display label. Combines buy and
 * sell requests -- "what are people asking Fi about most," not split by direction.
 */
export async function getTopRequests(limit = 10, sinceDays = 30): Promise<TopRequest[]> {
  return withSchema(async (pool) => {
    const result = await pool.query<{ query: string; count: string }>(
      `SELECT
         (array_agg(query ORDER BY created_at DESC))[1] AS query,
         count(*) AS count
       FROM search_requests
       WHERE created_at >= now() - ($1 || ' days')::interval
       GROUP BY lower(trim(query))
       ORDER BY count(*) DESC, lower(trim(query)) ASC
       LIMIT $2`,
      [String(sinceDays), limit]
    );
    return result.rows.map((r) => ({ query: r.query, count: Number(r.count) }));
  });
}
