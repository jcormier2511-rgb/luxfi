import { Pool } from 'pg';
import { getWatchFactsClient, WatchFactsListing } from '../adapters/watchfacts.client';
import { ingestApiPosting } from './posting.service';
import { tryAddPostingImage } from './image.service';
import { runMatchingForPosting } from './matching.service';
import crypto from 'crypto';

export interface SyncOutcome {
  status: 'ok' | 'error' | 'disabled';
  activeCount: number;
  error?: string;
}

async function recordAttempt(pool: Pool, syncType: 'FS' | 'WTB'): Promise<void> {
  await pool.query(
    `UPDATE sync_meta SET last_attempt_at = now(), sync_count = sync_count + 1, updated_at = now()
     WHERE sync_type = $1`,
    [syncType]
  );
}

async function recordSuccess(pool: Pool, syncType: 'FS' | 'WTB', activeCount: number): Promise<void> {
  await pool.query(
    `UPDATE sync_meta SET last_sync_at = now(), last_sync_status = 'ok', last_sync_error = NULL,
       active_count = $2, enabled = true, updated_at = now()
     WHERE sync_type = $1`,
    [syncType, activeCount]
  );
}

async function recordFailure(pool: Pool, syncType: 'FS' | 'WTB', error: string): Promise<void> {
  // Deliberately does not touch last_sync_at/active_count -- the last successful
  // sync's data must survive a failed or guarded run (spec section 13).
  await pool.query(
    `UPDATE sync_meta SET last_sync_status = 'error', last_sync_error = $2, updated_at = now()
     WHERE sync_type = $1`,
    [syncType, error]
  );
}

async function recordDisabled(pool: Pool, syncType: 'FS' | 'WTB'): Promise<void> {
  await pool.query(
    `UPDATE sync_meta SET last_sync_status = 'disabled', enabled = false, updated_at = now() WHERE sync_type = $1`,
    [syncType]
  );
}

async function ingestAndMatch(pool: Pool, listing: WatchFactsListing): Promise<string> {
  const { posting, materiallyChanged } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: listing.postingType,
    externalListingId: listing.externalListingId,
    brand: listing.brand,
    model: listing.model,
    referenceNumber: listing.referenceNumber,
    dial: listing.dial,
    material: listing.material,
    year: listing.year,
    condition: listing.condition,
    boxPapers: listing.boxPapers,
    askingPrice: listing.askingPrice,
    maxBid: listing.maxBid,
    currency: listing.currency,
    location: listing.location,
    country: listing.country,
    detailUrl: listing.detailUrl,
    originalDescription: listing.originalDescription,
    contactName: listing.contactName,
    contactMethods: listing.contactMethods,
  });

  for (const [index, image] of (listing.images ?? []).entries()) {
    // Images are never durable-fetched here for MVP (no approved storage provider
    // wired up yet -- spec 8.3, open dependency 3); we retain the source URL as-is
    // and skip only on obviously bad input. A failed/absent image never blocks
    // ingestion (spec 8.3).
    await tryAddPostingImage(pool, {
      postingId: posting.id,
      sourceUrl: image.url,
      mimeType: image.mimeType ?? 'image/jpeg',
      fileSize: 1, // unknown until downloaded; a real durable-storage pass would populate this
      contentHash: crypto.createHash('sha256').update(image.url).digest('hex'),
      displayOrder: index,
      isPrimary: index === 0,
    });
  }

  await runMatchingForPosting(pool, posting.id, materiallyChanged);
  return posting.externalListingId ?? listing.externalListingId;
}

/**
 * Refreshes live FS inventory from the WatchFacts API (spec section 13).
 * Zero results are treated as a guarded failure (not "the market is empty")
 * so a transient auth/parsing problem can never silently wipe inventory.
 */
export async function runFsSync(pool: Pool): Promise<SyncOutcome> {
  await recordAttempt(pool, 'FS');
  let listings: WatchFactsListing[];
  try {
    listings = await getWatchFactsClient().fetchAllActiveFsListings();
  } catch (err) {
    const message = (err as Error).message;
    await recordFailure(pool, 'FS', message);
    return { status: 'error', activeCount: await currentActiveCount(pool, 'FS'), error: message };
  }

  if (listings.length === 0) {
    const message = 'zero-result safeguard triggered: refusing to treat an empty FS response as authoritative';
    await recordFailure(pool, 'FS', message);
    return { status: 'error', activeCount: await currentActiveCount(pool, 'FS'), error: message };
  }

  const seenExternalIds: string[] = [];
  for (const listing of listings) {
    try {
      seenExternalIds.push(await ingestAndMatch(pool, listing));
    } catch (err) {
      // One bad listing must not fail the whole FS sync run.
      // eslint-disable-next-line no-console
      console.warn(`[sync:FS] failed to ingest listing ${listing.externalListingId}: ${(err as Error).message}`);
    }
  }

  // Mark missing FS listings inactive only after this fully successful sync (spec 13).
  await pool.query(
    `UPDATE postings SET status = 'source_inactive', updated_at = now()
     WHERE source_platform = 'watchfacts' AND source_type = 'api' AND posting_type = 'FS'
       AND status = 'active' AND external_listing_id != ALL($1::text[])`,
    [seenExternalIds]
  );

  const activeCount = await currentActiveCount(pool, 'FS');
  await recordSuccess(pool, 'FS', activeCount);
  return { status: 'ok', activeCount };
}

/**
 * WTB sync stays disabled by default (ENABLE_WTB_SYNC=false) until the exact
 * authenticated external WTB request is captured; its absence never blocks
 * chat-originated WTB postings from matching live FS inventory (spec 2/13).
 */
export async function runWtbSync(pool: Pool): Promise<SyncOutcome> {
  if ((process.env.ENABLE_WTB_SYNC ?? 'false') !== 'true') {
    await recordDisabled(pool, 'WTB');
    return { status: 'disabled', activeCount: await currentActiveCount(pool, 'WTB') };
  }

  await recordAttempt(pool, 'WTB');
  let listings: WatchFactsListing[];
  try {
    listings = await getWatchFactsClient().fetchAllActiveWtbListings();
  } catch (err) {
    const message = (err as Error).message;
    await recordFailure(pool, 'WTB', message);
    return { status: 'error', activeCount: await currentActiveCount(pool, 'WTB'), error: message };
  }

  const seenExternalIds: string[] = [];
  for (const listing of listings) {
    try {
      seenExternalIds.push(await ingestAndMatch(pool, listing));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sync:WTB] failed to ingest listing ${listing.externalListingId}: ${(err as Error).message}`);
    }
  }

  await pool.query(
    `UPDATE postings SET status = 'source_inactive', updated_at = now()
     WHERE source_platform = 'watchfacts' AND source_type = 'api' AND posting_type = 'WTB'
       AND status = 'active' AND external_listing_id != ALL($1::text[])`,
    [seenExternalIds]
  );

  const activeCount = await currentActiveCount(pool, 'WTB');
  await recordSuccess(pool, 'WTB', activeCount);
  return { status: 'ok', activeCount };
}

async function currentActiveCount(pool: Pool, postingType: 'FS' | 'WTB'): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM postings
     WHERE source_platform = 'watchfacts' AND source_type = 'api' AND posting_type = $1 AND status = 'active'`,
    [postingType]
  );
  return rows[0]?.count ?? 0;
}

export async function getSyncStatus(pool: Pool): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `SELECT sync_type, last_attempt_at, last_sync_at, last_sync_status, last_sync_error, sync_count, active_count, enabled
     FROM sync_meta ORDER BY sync_type`
  );
  return rows;
}
