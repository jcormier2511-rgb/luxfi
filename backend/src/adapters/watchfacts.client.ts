import { ContactMethod } from '../types/domain';

export interface WatchFactsListing {
  externalListingId: string;
  postingType: 'FS' | 'WTB';
  brand?: string;
  model?: string;
  referenceNumber?: string;
  dial?: string;
  material?: string;
  year?: number;
  condition?: string;
  boxPapers?: string;
  askingPrice?: number;
  maxBid?: number;
  currency?: string;
  location?: string;
  country?: string;
  detailUrl?: string;
  originalDescription?: string;
  contactName?: string;
  contactMethods?: ContactMethod[];
  images?: { sourceMediaId?: string; url: string; mimeType?: string }[];
}

/**
 * WatchFacts inventory API client. FS sync uses this; WTB sync also uses this
 * interface but stays disabled by default (ENABLE_WTB_SYNC=false) until the
 * exact authenticated external WTB request is captured (spec section 2/13,
 * open dependency 4) -- that is explicitly non-blocking for the matching MVP,
 * since chat-originated WTB postings already match live FS inventory.
 */
export interface WatchFactsClient {
  fetchAllActiveFsListings(): Promise<WatchFactsListing[]>;
  fetchAllActiveWtbListings(): Promise<WatchFactsListing[]>;
}

export class WatchFactsNotConfiguredError extends Error {}

/**
 * No live WatchFacts API base URL/credentials are available in this session
 * (nothing to inspect/continue from -- see implementer summary). Every call
 * fails clearly and immediately, which is exactly the failure path the sync
 * service must already handle safely: preserve the last successful FS data
 * and record the error rather than wiping inventory (spec section 13).
 */
export class UnconfiguredWatchFactsClient implements WatchFactsClient {
  async fetchAllActiveFsListings(): Promise<WatchFactsListing[]> {
    throw new WatchFactsNotConfiguredError('WATCHFACTS_API_BASE_URL is not configured');
  }

  async fetchAllActiveWtbListings(): Promise<WatchFactsListing[]> {
    throw new WatchFactsNotConfiguredError('WATCHFACTS_API_BASE_URL is not configured');
  }
}

/**
 * Real client skeleton for when WatchFacts API credentials are supplied. The
 * exact authenticated request/response shape was not available to capture in
 * this session, so this issues a best-effort structured request against a
 * configurable base URL/paths and expects a JSON array of listings; adjust
 * WATCHFACTS_FS_LISTINGS_PATH/parsing here once the real contract is known.
 * Never scrapes CTA text (spec 13).
 */
export class HttpWatchFactsClient implements WatchFactsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  private async authHeader(): Promise<Record<string, string>> {
    return { Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` };
  }

  private async fetchPaginated(path: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let page = 1;
    const headers = await this.authHeader();
    for (;;) {
      const url = `${this.baseUrl}${path}${path.includes('?') ? '&' : '?'}page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`WatchFacts API request failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { items?: Record<string, unknown>[]; hasNextPage?: boolean };
      const items = Array.isArray(body.items) ? body.items : [];
      results.push(...items);
      if (!body.hasNextPage || items.length === 0) break;
      page += 1;
    }
    return results;
  }

  private mapListing(raw: Record<string, unknown>, postingType: 'FS' | 'WTB'): WatchFactsListing {
    return {
      externalListingId: String(raw.id ?? raw.listingId ?? ''),
      postingType,
      brand: raw.brand as string | undefined,
      model: raw.model as string | undefined,
      referenceNumber: (raw.referenceNumber ?? raw.reference) as string | undefined,
      dial: raw.dial as string | undefined,
      material: raw.material as string | undefined,
      year: raw.year as number | undefined,
      condition: raw.condition as string | undefined,
      boxPapers: (raw.boxPapers ?? raw.box_papers) as string | undefined,
      askingPrice: (raw.price ?? raw.askingPrice) as number | undefined,
      currency: raw.currency as string | undefined,
      location: raw.location as string | undefined,
      country: raw.country as string | undefined,
      detailUrl: (raw.detailUrl ?? raw.url) as string | undefined,
      originalDescription: raw.description as string | undefined,
      images: Array.isArray(raw.images)
        ? (raw.images as Record<string, unknown>[]).map((img) => ({ url: String(img.url) }))
        : undefined,
    };
  }

  async fetchAllActiveFsListings(): Promise<WatchFactsListing[]> {
    const path = process.env.WATCHFACTS_FS_LISTINGS_PATH ?? '/api/listings?type=fs';
    const raw = await this.fetchPaginated(path);
    return raw.map((r) => this.mapListing(r, 'FS'));
  }

  async fetchAllActiveWtbListings(): Promise<WatchFactsListing[]> {
    const path = process.env.WATCHFACTS_WTB_LISTINGS_PATH ?? '/api/listings?type=wtb';
    const raw = await this.fetchPaginated(path);
    return raw.map((r) => this.mapListing(r, 'WTB'));
  }
}

let client: WatchFactsClient | undefined;

export function getWatchFactsClient(): WatchFactsClient {
  if (!client) {
    const baseUrl = process.env.WATCHFACTS_API_BASE_URL;
    const username = process.env.WATCHFACTS_API_USERNAME;
    const password = process.env.WATCHFACTS_API_PASSWORD;
    client = baseUrl && username && password
      ? new HttpWatchFactsClient(baseUrl, username, password)
      : new UnconfiguredWatchFactsClient();
  }
  return client;
}

export function setWatchFactsClient(custom: WatchFactsClient): void {
  client = custom;
}
