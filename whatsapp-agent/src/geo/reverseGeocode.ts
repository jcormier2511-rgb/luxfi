/**
 * Turns a shared location pin (WhatsApp/Telegram both support "share my location" as a native
 * message type) into the same "City, Country" style string a customer would otherwise type in
 * answer to "Any location preference?" — so a location share is just another way to answer that
 * one question, and every existing downstream consumer (region matching, display, storage) needs
 * no changes at all.
 *
 * Uses OpenStreetMap's Nominatim, which needs no API key/signup — matching this codebase's
 * existing bias toward free, keyless external lookups where one exists (see watchfacts/
 * urlValidator.ts). Nominatim's usage policy requires a real identifying User-Agent and caps
 * usage at ~1 request/second, which this bot's expected volume is nowhere near.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const REQUEST_TIMEOUT_MS = 5000;
const USER_AGENT = "FiWatchBot/1.0 (+https://watchfacts.com)";

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
}

/**
 * Resolves coordinates to a place name, or null — never a guess — when Nominatim is unreachable,
 * times out, or returns nothing usable (open water, an unrecognized area). The place name prefers
 * the finest-grained field Nominatim actually returned (city, then town, then village, then a
 * broader county/state) alongside the country, the same granularity a person would type
 * themselves ("Miami" or "Broward County", not a full street address).
 */
export async function reverseGeocode({ latitude, longitude }: Coordinates): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${NOMINATIM_REVERSE_URL}?format=jsonv2&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&zoom=10&addressdetails=1`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (!res.ok) {
      console.error(`[geo] reverse geocode request failed (${res.status}):`, await res.text().catch(() => "<no body>"));
      return null;
    }
    const body = (await res.json()) as { address?: NominatimAddress };
    const address = body.address;
    if (!address) return null;
    const place = address.city ?? address.town ?? address.village ?? address.county ?? address.state;
    const parts = [place, address.country].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(", ") : null;
  } catch (err) {
    console.error("[geo] reverse geocode threw:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
