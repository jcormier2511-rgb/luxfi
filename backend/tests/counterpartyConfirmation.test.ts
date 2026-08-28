import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { approveMatch, confirmCounterparty, getRevealedContact } from '../src/services/approval.service';
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

async function makeMatchedPair(fsOverrides: Record<string, unknown> = {}, wtbOverrides: Record<string, unknown> = {}) {
  idCounter += 1;
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `fs-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: seller,
    referenceNumber: '116500LN',
    askingPrice: 18500,
    ...fsOverrides,
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '116500LN',
    maxBid: 20000,
    ...wtbOverrides,
  });
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  return { seller, buyer, matchId: rows[0].id as string };
}

test('approving a match with an unauthorized counterparty contact requests their confirmation, not the contact itself', async () => {
  const { seller, buyer, matchId } = await makeMatchedPair(
    { contactMethods: [{ type: 'whatsapp', value: '+1-seller', authorizedForSharing: false }] },
  );

  await approveMatch(pool, matchId, buyer);

  const requestMsg = stub.sent.find((m) => m.recipientCanonicalUserId === seller && m.buttons?.some((b) => b.action.startsWith('confirm-share')));
  expect(requestMsg).toBeDefined();
  expect(requestMsg?.buttons?.map((b) => b.action)).toEqual([`confirm-share:${matchId}`, `decline-share:${matchId}`]);

  // The approver has not yet received the contact.
  expect(await getRevealedContact(pool, matchId, buyer)).toBeNull();
  const deliveryMsg = stub.sent.find((m) => m.recipientCanonicalUserId === buyer && m.text.includes("You're connected"));
  expect(deliveryMsg).toBeUndefined();
});

test('confirming delivers the contact to the approver exactly once, even if confirmed twice', async () => {
  const { seller, buyer, matchId } = await makeMatchedPair(
    { contactMethods: [{ type: 'whatsapp', value: '+1-seller', authorizedForSharing: false }] },
  );
  await approveMatch(pool, matchId, buyer);
  stub.sent = [];

  await confirmCounterparty(pool, matchId, seller, true);
  const delivered = stub.sent.filter((m) => m.recipientCanonicalUserId === buyer && m.text.includes('+1-seller'));
  expect(delivered.length).toBe(1);

  await confirmCounterparty(pool, matchId, seller, true);
  const deliveredAgain = stub.sent.filter((m) => m.recipientCanonicalUserId === buyer && m.text.includes('+1-seller'));
  expect(deliveredAgain.length).toBe(1); // no duplicate delivery
});

test('declining never delivers the contact', async () => {
  const { seller, buyer, matchId } = await makeMatchedPair(
    { contactMethods: [{ type: 'whatsapp', value: '+1-seller', authorizedForSharing: false }] },
  );
  await approveMatch(pool, matchId, buyer);
  stub.sent = [];

  await confirmCounterparty(pool, matchId, seller, false);
  expect(await getRevealedContact(pool, matchId, buyer)).toBeNull();
  expect(stub.sent.some((m) => m.text.includes('+1-seller'))).toBe(false);
});

test('when the counterparty contact is already authorized, approving delivers it immediately with no confirmation request', async () => {
  const { seller, buyer, matchId } = await makeMatchedPair(
    { contactMethods: [{ type: 'whatsapp', value: '+1-seller-open', authorizedForSharing: true }] },
  );

  await approveMatch(pool, matchId, buyer);

  const requestMsg = stub.sent.find((m) => m.buttons?.some((b) => b.action.startsWith('confirm-share')));
  expect(requestMsg).toBeUndefined();
  const delivered = stub.sent.find((m) => m.recipientCanonicalUserId === buyer && m.text.includes('+1-seller-open'));
  expect(delivered).toBeDefined();
  void seller;
});
