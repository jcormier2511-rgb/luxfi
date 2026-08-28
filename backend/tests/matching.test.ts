import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { computeMatch, getMatchConfig, reconcileMatches, runMatchingForPosting } from '../src/services/matching.service';
import { passMatch } from '../src/services/approval.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

let pool: Pool;
let stub: StubMessagingAdapter;
let idCounter = 0;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(() => {
  stub = new StubMessagingAdapter();
  setMessagingAdapter(stub);
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

async function makeFs(ownerId: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

async function makeWtb(ownerId: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  });
}

test('7. a new WTB immediately matches an existing FS', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await runMatchingForPosting(pool, fs.id, true);

  const { posting: wtb } = await makeWtb(buyer);
  const { matchCount } = await runMatchingForPosting(pool, wtb.id, true);
  expect(matchCount).toBe(1);

  const { rows } = await pool.query('SELECT * FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  expect(rows.length).toBe(1);
});

test('8. a new FS immediately matches an existing WTB', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  const { posting: fs } = await makeFs(seller);
  const { matchCount } = await runMatchingForPosting(pool, fs.id, true);
  expect(matchCount).toBe(1);
});

test('9. an unmatched WTB matches when a future FS arrives', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: wtb } = await makeWtb(buyer);
  const first = await runMatchingForPosting(pool, wtb.id, true);
  expect(first.matchCount).toBe(0);

  const { posting: fs } = await makeFs(seller);
  const second = await runMatchingForPosting(pool, fs.id, true);
  expect(second.matchCount).toBe(1);
});

test('10. an unmatched FS matches when a future WTB arrives', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  const first = await runMatchingForPosting(pool, fs.id, true);
  expect(first.matchCount).toBe(0);

  const { posting: wtb } = await makeWtb(buyer);
  const second = await runMatchingForPosting(pool, wtb.id, true);
  expect(second.matchCount).toBe(1);
});

test('11. a user is never matched with their own listing', async () => {
  const user = await makeUser();
  const { posting: fs } = await makeFs(user);
  const { posting: wtb } = await makeWtb(user);
  const result = await runMatchingForPosting(pool, wtb.id, true);
  expect(result.matchCount).toBe(0);
  void fs;
});

test('12. same-side listings never match', async () => {
  const a = await makeUser();
  const b = await makeUser();
  const { posting: fs1 } = await makeFs(a);
  const { posting: fs2 } = await makeFs(b);
  const computation = computeMatch(fs1, fs2, getMatchConfig());
  expect(computation).toBeNull();
});

test('13. inactive and expired postings never match', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await pool.query("UPDATE postings SET status = 'sold' WHERE id = $1", [fs.id]);

  const { posting: wtb } = await makeWtb(buyer);
  const result = await runMatchingForPosting(pool, wtb.id, true);
  expect(result.matchCount).toBe(0);
});

test('14. mandatory attribute, location, and price constraints are respected', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller, { dial: 'black', askingPrice: 25000 });
  await runMatchingForPosting(pool, fs.id, true);

  const { posting: wtbWrongDial } = await makeWtb(buyer, { dial: 'white' });
  const noMatch = await runMatchingForPosting(pool, wtbWrongDial.id, true);
  expect(noMatch.matchCount).toBe(0);

  const { posting: wtbOverBudget } = await makeWtb(buyer, { maxBid: 20000 });
  const priceBlocked = await runMatchingForPosting(pool, wtbOverBudget.id, true);
  expect(priceBlocked.matchCount).toBe(0);
});

test('15. a passed match is not resurfaced without a material revision', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  const matchRow = (await pool.query('SELECT * FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ])).rows[0];

  await passMatch(pool, matchRow.id, buyer);

  // Non-material reconciliation rerun must not resurface it.
  await runMatchingForPosting(pool, fs.id, false);
  const stillPassed = (await pool.query('SELECT decision FROM match_recipients WHERE match_id = $1 AND recipient_canonical_user_id = $2', [
    matchRow.id,
    buyer,
  ])).rows[0];
  expect(stillPassed.decision).toBe('passed');

  // A material change to the FS listing (price drop) must create a new revision.
  await pool.query('UPDATE postings SET asking_price = 15000, updated_at = now() WHERE id = $1', [fs.id]);
  await runMatchingForPosting(pool, fs.id, true);

  const revised = (await pool.query('SELECT revision FROM matches WHERE id = $1', [matchRow.id])).rows[0];
  expect(revised.revision).toBe(2);
  const newRecipientRow = (await pool.query(
    'SELECT decision FROM match_recipients WHERE match_id = $1 AND recipient_canonical_user_id = $2 AND match_revision = 2',
    [matchRow.id, buyer]
  )).rows[0];
  expect(newRecipientRow.decision).toBe('pending');
});

test('16. periodic reconciliation recovers a match missed by the immediate event path without duplicating notifications', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  // Deliberately skip calling runMatchingForPosting to simulate a missed webhook/process failure.
  await makeFs(seller);
  await makeWtb(buyer);

  const { rows: beforeMatches } = await pool.query('SELECT COUNT(*)::int AS c FROM matches');
  expect(beforeMatches[0].c).toBe(0);

  await reconcileMatches(pool);
  const { rows: afterFirst } = await pool.query('SELECT COUNT(*)::int AS c FROM matches');
  expect(afterFirst[0].c).toBe(1);
  const notificationsAfterFirst = stub.sent.length;
  expect(notificationsAfterFirst).toBeGreaterThan(0);

  await reconcileMatches(pool);
  const { rows: afterSecond } = await pool.query('SELECT COUNT(*)::int AS c FROM matches');
  expect(afterSecond[0].c).toBe(1);
  expect(stub.sent.length).toBe(notificationsAfterFirst); // no duplicate notifications
});
