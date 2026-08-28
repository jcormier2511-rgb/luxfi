import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { approveMatch } from '../src/services/approval.service';
import {
  findMostRecentApprovedMatchForUser,
  getVouchSummary,
  requestVouch,
  respondToVouch,
} from '../src/services/vouch.service';
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
    platformUserId: `vouch-user-${idCounter}-${Date.now()}`,
  });
  return identity.canonicalUserId;
}

async function makeApprovedDeal(): Promise<{ seller: string; buyer: string; matchId: string }> {
  idCounter += 1;
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `vouch-fs-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: seller,
    referenceNumber: '116500LN',
    askingPrice: 18500,
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `vouch-wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  const matchId = rows[0].id as string;
  await approveMatch(pool, matchId, buyer);
  return { seller, buyer, matchId };
}

test('requesting a vouch notifies the counterparty and is idempotent per deal', async () => {
  const { seller, buyer, matchId } = await makeApprovedDeal();

  const first = await requestVouch(pool, matchId, buyer);
  expect(first.status).toBe('requested');
  const request = stub.sent.find(
    (m) => m.recipientCanonicalUserId === seller && m.buttons?.some((b) => b.action.startsWith('vouch-'))
  );
  expect(request).toBeDefined();
  expect(request?.buttons?.map((b) => b.action)).toEqual([`vouch-give:${first.vouchId}`, `vouch-decline:${first.vouchId}`]);

  stub.sent = [];
  const second = await requestVouch(pool, matchId, buyer);
  expect(second.status).toBe('already_requested');
  expect(stub.sent.length).toBe(0);
});

test('requesting a vouch for a match the requester has no side in returns no_deal_found', async () => {
  const { matchId } = await makeApprovedDeal();
  const stranger = await makeUser();
  const result = await requestVouch(pool, matchId, stranger);
  expect(result.status).toBe('no_deal_found');
});

test('giving a vouch increments the subject\'s count and notifies them; declining does not', async () => {
  const { seller, buyer, matchId } = await makeApprovedDeal();
  const { vouchId } = await requestVouch(pool, matchId, buyer);
  stub.sent = [];

  await respondToVouch(pool, vouchId as string, true);
  const summary = await getVouchSummary(pool, buyer);
  expect(summary.positiveVouchCount).toBe(1);
  expect(stub.sent.some((m) => m.recipientCanonicalUserId === buyer && m.text.includes('positive review'))).toBe(true);
  void seller;
});

test('declining a vouch request does not increment the count', async () => {
  const { buyer, matchId } = await makeApprovedDeal();
  const { vouchId } = await requestVouch(pool, matchId, buyer);
  stub.sent = [];

  await respondToVouch(pool, vouchId as string, false);
  const summary = await getVouchSummary(pool, buyer);
  expect(summary.positiveVouchCount).toBe(0);
  expect(stub.sent.length).toBe(0);
});

test('responding twice to the same vouch only counts once', async () => {
  const { buyer, matchId } = await makeApprovedDeal();
  const { vouchId } = await requestVouch(pool, matchId, buyer);

  await respondToVouch(pool, vouchId as string, true);
  await respondToVouch(pool, vouchId as string, true);
  const summary = await getVouchSummary(pool, buyer);
  expect(summary.positiveVouchCount).toBe(1);
});

test('findMostRecentApprovedMatchForUser finds the latest approval, not just any match', async () => {
  const buyer = await makeUser();
  expect(await findMostRecentApprovedMatchForUser(pool, buyer)).toBeNull();

  idCounter += 1;
  const seller = await makeUser();
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `recent-fs-${idCounter}`,
    ownerCanonicalUserId: seller,
    referenceNumber: '116500LN',
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `recent-wtb-${idCounter}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '116500LN',
  });
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  await approveMatch(pool, rows[0].id, buyer);

  expect(await findMostRecentApprovedMatchForUser(pool, buyer)).toBe(rows[0].id);
});

test('a positive vouch count is surfaced in later Potential Match notifications', async () => {
  const { seller, buyer, matchId } = await makeApprovedDeal();
  const { vouchId } = await requestVouch(pool, matchId, buyer);
  await respondToVouch(pool, vouchId as string, true); // buyer now has 1 positive review
  stub.sent = [];

  // A second, independent deal for the same buyer surfaces their vouch count to the new seller.
  idCounter += 1;
  const secondSeller = await makeUser();
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `vouch-notif-fs-${idCounter}`,
    ownerCanonicalUserId: secondSeller,
    referenceNumber: '5711/1A',
    askingPrice: 90000,
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `vouch-notif-wtb-${idCounter}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '5711/1A',
    maxBid: 95000,
  });
  await runMatchingForPosting(pool, wtb.id, true);

  const notification = stub.sent.find((m) => m.recipientCanonicalUserId === secondSeller && m.text.includes('Potential Match'));
  expect(notification?.text).toContain('1 positive review');
  void seller;
});
