import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting, extendPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { approveMatch, passMatch } from '../src/services/approval.service';
import { setManualEntitlementOverride } from '../src/services/entitlement.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

let pool: Pool;
let idCounter = 0;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(() => {
  setMessagingAdapter(new StubMessagingAdapter());
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

async function makeUser(): Promise<string> {
  idCounter += 1;
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `user-${idCounter}-${Date.now()}`,
  });
  return identity.canonicalUserId;
}

async function makeFs(ownerId: string) {
  idCounter += 1;
  return ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `fs-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: ownerId,
    referenceNumber: '116500LN',
    askingPrice: 18500,
    currency: 'USD',
  });
}

async function makeWtb(ownerId: string) {
  idCounter += 1;
  return ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: ownerId,
    referenceNumber: '116500LN',
    maxBid: 20000,
    currency: 'USD',
  });
}

async function matchIdFor(fsId: string, wtbId: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fsId,
    wtbId,
  ]);
  return rows[0].id;
}

test('17. five surfaced-but-unapproved matches do not close a monitor', async () => {
  const buyer = await makeUser();
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  for (let i = 0; i < 5; i += 1) {
    const seller = await makeUser();
    const { posting: fs } = await makeFs(seller);
    await runMatchingForPosting(pool, fs.id, true);
  }

  const { rows } = await pool.query('SELECT status, approved_match_count FROM postings WHERE id = $1', [wtb.id]);
  expect(rows[0].status).toBe('active');
  expect(rows[0].approved_match_count).toBe(0);
});

test('18. five passed matches do not close a monitor', async () => {
  const buyer = await makeUser();
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  for (let i = 0; i < 5; i += 1) {
    const seller = await makeUser();
    const { posting: fs } = await makeFs(seller);
    await runMatchingForPosting(pool, fs.id, true);
    const matchId = await matchIdFor(fs.id, wtb.id);
    await passMatch(pool, matchId, buyer);
  }

  const { rows } = await pool.query('SELECT status, approved_match_count FROM postings WHERE id = $1', [wtb.id]);
  expect(rows[0].status).toBe('active');
  expect(rows[0].approved_match_count).toBe(0);
});

test('19. the fifth approved match closes only the relevant posting monitor', async () => {
  const buyer = await makeUser();
  // The 5-per-posting monitor limit is independent of the 3-complimentary-approval
  // account trial (spec 6.1/11.1: "separate counters"). This test isolates the
  // 5-limit by granting a manual entitlement override up front so approvals 4-5
  // aren't blocked by the trial lock this MVP enforces for approval #4+.
  await setManualEntitlementOverride(pool, buyer, true, 'admin@luxfi.test', 'isolate 5-match-limit test');
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  const fsIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const seller = await makeUser();
    const { posting: fs } = await makeFs(seller);
    await runMatchingForPosting(pool, fs.id, true);
    fsIds.push(fs.id);
    const matchId = await matchIdFor(fs.id, wtb.id);
    const outcome = await approveMatch(pool, matchId, buyer);
    expect(outcome.status).toBe('approved');
  }

  const { rows: wtbRows } = await pool.query('SELECT status, approved_match_count FROM postings WHERE id = $1', [
    wtb.id,
  ]);
  expect(wtbRows[0].approved_match_count).toBe(5);
  expect(wtbRows[0].status).toBe('completed_match_limit');

  // The FS postings themselves were never approved by their own owners, so they stay active.
  const { rows: fsRows } = await pool.query('SELECT status, approved_match_count FROM postings WHERE id = ANY($1)', [
    fsIds,
  ]);
  for (const row of fsRows) {
    expect(row.status).toBe('active');
    expect(row.approved_match_count).toBe(0);
  }
});

test('20. a properly extended posting remains eligible after its original 30-day period', async () => {
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller);
  const originalExpiry = fs.expiresAt;

  const extended = await extendPosting(pool, fs.id);
  expect(extended.expiresAt.getTime()).toBeGreaterThan(originalExpiry.getTime());

  // Simulate being past the original 30-day window but still within the extension.
  await pool.query(
    "UPDATE postings SET last_seen_at = now() - interval '31 days' WHERE id = $1",
    [fs.id]
  );
  const { rows } = await pool.query('SELECT status, expires_at FROM postings WHERE id = $1', [fs.id]);
  expect(rows[0].status).toBe('active');
  expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
});

test('21. an expired, unextended posting is excluded from matching', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await pool.query("UPDATE postings SET expires_at = now() - interval '1 day' WHERE id = $1", [fs.id]);

  const { posting: wtb } = await makeWtb(buyer);
  const result = await runMatchingForPosting(pool, wtb.id, true);
  expect(result.matchCount).toBe(0);
});

test('22. sold, found, stopped, source_inactive, and admin_closed postings stop matching', async () => {
  const statuses = ['sold', 'found', 'stopped', 'source_inactive', 'admin_closed'];
  for (const status of statuses) {
    const seller = await makeUser();
    const buyer = await makeUser();
    const { posting: fs } = await makeFs(seller);
    await pool.query('UPDATE postings SET status = $2 WHERE id = $1', [fs.id, status]);

    const { posting: wtb } = await makeWtb(buyer);
    const result = await runMatchingForPosting(pool, wtb.id, true);
    expect(result.matchCount).toBe(0);
  }
});
