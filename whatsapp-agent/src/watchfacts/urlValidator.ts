/**
 * Confirms a listing detail URL actually resolves before it's ever included in a WhatsApp
 * match card — a constructed `https://watchfacts.com/flash-sales/${id}` URL isn't guaranteed
 * to be a valid public route (the id format, an expired/removed listing, or a site-side error
 * can all produce a broken link), so this treats "unknown" as "omit the link" rather than
 * trusting it. This can only check the HTTP status code (any 2xx counts as reachable) — if
 * WatchFacts' own error page happens to return 200 with error content instead of a real error
 * status, this validator won't catch that; that would need actual page-content inspection,
 * which is out of scope here.
 *
 * A short in-memory cache avoids re-checking the same URL on every search within a short
 * window — real-time per-message validation would otherwise hit watchfacts.com's servers on
 * every single user search, which looks like abuse from their side and adds latency to every
 * reply for no benefit once a URL's reachability is already known.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TIMEOUT_MS = 3000;

interface CacheEntry {
  checkedAt: number;
  valid: boolean;
}

const cache = new Map<string, CacheEntry>();

async function fetchWithTimeout(url: string, method: "GET", timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True only for a confirmed-reachable URL (any 2xx). Never throws: a timeout, network error, or
 * non-2xx status all resolve to false, so a slow/down third-party site never blocks or delays
 * a reply beyond the timeout — it just means the link gets omitted.
 */
export async function isUrlReachable(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.valid;

  let valid = false;
  try {
    // GET, not HEAD. This used to send a HEAD and only fall back to GET on a 405, and a live
    // link it approved that way opened to "500 | SERVER ERROR": sites routinely answer HEAD
    // with 200 from a cheap path (or a CDN) while the real render fails. The only check that
    // means "this will open for the customer" is the request the customer's browser makes.
    // The page is small HTML; the cache above keeps this to one fetch per URL per 10 minutes.
    const res = await fetchWithTimeout(url, "GET", timeoutMs);
    valid = res.ok;
  } catch {
    valid = false;
  }

  cache.set(url, { checkedAt: Date.now(), valid });
  return valid;
}

/** Returns `url` unchanged if it's reachable, or `undefined` if it's missing/unreachable — so a caller can just drop the field rather than branch on the boolean itself. */
export async function getValidatedListingUrl(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  return (await isUrlReachable(url)) ? url : undefined;
}

export function _clearUrlValidationCacheForTests(): void {
  cache.clear();
}
