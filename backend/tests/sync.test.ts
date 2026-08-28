import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { setWatchFactsClient, WatchFactsClient, WatchFactsListing } from '../src/adapters/watchfacts.client';
import { runFsSync, runWtbSync, getSyncStatus } from '../src/services/sync.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

let pool: Pool;

class FakeWatchFactsClient implements WatchFactsClient {
  fsListings: WatchFactsListing[] = [];
  wtbListings: WatchFactsListing[] = [];
  fsError: string | null = null;
  wtbError: string | null = null;

  async fetchAllActiveFsListings(): Promise<WatchFactsListing[]> {
    if (this.fsError) throw new Error(this.fsError);
    return this.fsListings;
  }

  async fetchAllActiveWtbListings(): Promise<WatchFactsListing[]> {
    if (this.wtbError) throw new Error(this.wtbError);
    return this.wtbListings;
  }
}

let fake: FakeWatchFactsClient;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(() => {
  fake = new FakeWatchFactsClient();
  setWatchFactsClient(fake);
  setMessagingAdapter(new StubMessagingAdapter());
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

function listing(id: string, overrides: Partial<WatchFactsListing> = {}): WatchFactsListing {
  return {
    externalListingId: id,
    postingType: 'FS',
    referenceNumber: `REF-${id}`,
    askingPrice: 10000,
    currency: 'USD',
    ...overrides,
  };
}

test('36. FS synchronization succeeds and persists when WTB synchronization is disabled or fails', async () => {
  process.env.ENABLE_WTB_SYNC = 'false';
  fake.fsListings = [listing('A'), listing('B')];

  const fsResult = await runFsSync(pool);
  expect(fsResult.status).toBe('ok');
  expect(fsResult.activeCount).toBe(2);

  const wtbResult = await runWtbSync(pool);
  expect(wtbResult.status).toBe('disabled');

  const { rows } = await pool.query(
    "SELECT status FROM postings WHERE source_platform = 'watchfacts' AND posting_type = 'FS'"
  );
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.status === 'active')).toBe(true);
});

test('37. a failed or guarded zero-result FS synchronization preserves prior valid inventory', async () => {
  fake.fsListings = [listing('A'), listing('B')];
  await runFsSync(pool);

  fake.fsListings = [];
  const guarded = await runFsSync(pool);
  expect(guarded.status).toBe('error');

  const { rows } = await pool.query(
    "SELECT status FROM postings WHERE source_platform = 'watchfacts' AND posting_type = 'FS'"
  );
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.status === 'active')).toBe(true);

  fake.fsError = 'auth failed';
  const failed = await runFsSync(pool);
  expect(failed.status).toBe('error');
  const { rows: stillThere } = await pool.query(
    "SELECT status FROM postings WHERE source_platform = 'watchfacts' AND posting_type = 'FS'"
  );
  expect(stillThere.every((r) => r.status === 'active')).toBe(true);
});

test('38. missing listings are deactivated only after a complete successful FS synchronization', async () => {
  fake.fsListings = [listing('A'), listing('B')];
  await runFsSync(pool);

  fake.fsListings = [listing('A')];
  await runFsSync(pool);

  const { rows } = await pool.query(
    `SELECT external_listing_id, status FROM postings
     WHERE source_platform = 'watchfacts' AND posting_type = 'FS' ORDER BY external_listing_id`
  );
  expect(rows).toEqual([
    { external_listing_id: 'A', status: 'active' },
    { external_listing_id: 'B', status: 'source_inactive' },
  ]);
});

test('42. per-type synchronization success and error status is recorded correctly', async () => {
  process.env.ENABLE_WTB_SYNC = 'true';
  fake.fsListings = [listing('A')];
  fake.wtbListings = [listing('W1', { postingType: 'WTB', referenceNumber: 'REF-W1' })];

  await runFsSync(pool);
  await runWtbSync(pool);

  const status = await getSyncStatus(pool);
  const fsRow = status.find((r) => r.sync_type === 'FS') as Record<string, unknown>;
  const wtbRow = status.find((r) => r.sync_type === 'WTB') as Record<string, unknown>;
  expect(fsRow.last_sync_status).toBe('ok');
  expect(fsRow.active_count).toBe(1);
  expect(wtbRow.last_sync_status).toBe('ok');
  expect(wtbRow.active_count).toBe(1);

  fake.wtbError = 'wtb boom';
  await runWtbSync(pool);
  const status2 = await getSyncStatus(pool);
  const wtbRow2 = status2.find((r) => r.sync_type === 'WTB') as Record<string, unknown>;
  expect(wtbRow2.last_sync_status).toBe('error');
  expect(wtbRow2.last_sync_error).toBe('wtb boom');
  // FS status must be unaffected by the WTB failure.
  const fsRow2 = status2.find((r) => r.sync_type === 'FS') as Record<string, unknown>;
  expect(fsRow2.last_sync_status).toBe('ok');

  process.env.ENABLE_WTB_SYNC = 'false';
});
