import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMatchingForPosting } from '../src/services/matching.service';
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
    platformUserId: `route-user-${idCounter}-${Date.now()}`,
  });
  return identity.canonicalUserId;
}

async function makeMatch(fsOverrides: Record<string, unknown> = {}) {
  idCounter += 1;
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `route-fs-${idCounter}-${Date.now()}`,
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
    externalListingId: `route-wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  return { seller, buyer, matchId: rows[0].id as string };
}

test('POST /matches/:id/approve requires recipientCanonicalUserId', async () => {
  const app = createApp(pool);
  const { matchId } = await makeMatch();
  const res = await request(app).post(`/matches/${matchId}/approve`).send({});
  expect(res.status).toBe(400);
});

test('POST /matches/:id/approve happy path returns 200 with the outcome', async () => {
  const app = createApp(pool);
  const { buyer, matchId } = await makeMatch();
  const res = await request(app).post(`/matches/${matchId}/approve`).send({ recipientCanonicalUserId: buyer });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'approved', duplicate: false, isComplimentary: true });
});

test('POST /matches/:id/approve returns 402 once the account is locked past its trial', async () => {
  const app = createApp(pool);
  const buyer = await makeUser();
  for (let i = 0; i < 3; i += 1) {
    idCounter += 1;
    const seller = await makeUser();
    const { posting: fs } = await ingestApiPosting(pool, {
      sourceType: 'api',
      platform: 'watchfacts',
      postingType: 'FS',
      externalListingId: `lock-fs-${idCounter}`,
      ownerCanonicalUserId: seller,
      referenceNumber: '116500LN',
    });
    await runMatchingForPosting(pool, fs.id, true);
    idCounter += 1;
    const { posting: wtb } = await ingestApiPosting(pool, {
      sourceType: 'api',
      platform: 'watchfacts',
      postingType: 'WTB',
      externalListingId: `lock-wtb-${idCounter}`,
      ownerCanonicalUserId: buyer,
      referenceNumber: '116500LN',
    });
    await runMatchingForPosting(pool, wtb.id, true);
    const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
      fs.id,
      wtb.id,
    ]);
    await request(app).post(`/matches/${rows[0].id}/approve`).send({ recipientCanonicalUserId: buyer });
  }

  const { matchId: fourthMatchId } = await makeMatch();
  // Re-point the fourth match's WTB side to the already-trial-exhausted buyer.
  await pool.query(
    `UPDATE postings SET canonical_user_id = $2 WHERE id = (SELECT wtb_posting_id FROM matches WHERE id = $1)`,
    [fourthMatchId, buyer]
  );
  const res = await request(app).post(`/matches/${fourthMatchId}/approve`).send({ recipientCanonicalUserId: buyer });
  expect(res.status).toBe(402);
  expect(res.body).toEqual({ status: 'locked', reason: 'locked_pending_admin_override' });
});

test('POST /matches/:id/pass requires recipientCanonicalUserId and otherwise returns 200', async () => {
  const app = createApp(pool);
  const { buyer, matchId } = await makeMatch();

  const bad = await request(app).post(`/matches/${matchId}/pass`).send({});
  expect(bad.status).toBe(400);

  const ok = await request(app).post(`/matches/${matchId}/pass`).send({ recipientCanonicalUserId: buyer });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ status: 'passed' });
});

test('POST /matches/:id/confirm-counterparty validates its body and records the decision', async () => {
  const app = createApp(pool);
  const { seller, matchId } = await makeMatch();

  const bad = await request(app).post(`/matches/${matchId}/confirm-counterparty`).send({ confirmed: true });
  expect(bad.status).toBe(400);

  const ok = await request(app)
    .post(`/matches/${matchId}/confirm-counterparty`)
    .send({ counterpartyCanonicalUserId: seller, confirmed: true });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ status: 'recorded' });
});

test('GET /matches/:id/contact requires the query param, 403s before authorization, 200s after', async () => {
  const app = createApp(pool);
  const { seller, buyer, matchId } = await makeMatch({
    contactMethods: [{ type: 'whatsapp', value: '+1-route-seller', authorizedForSharing: true }],
  });

  const missingParam = await request(app).get(`/matches/${matchId}/contact`);
  expect(missingParam.status).toBe(400);

  const notYetApproved = await request(app).get(`/matches/${matchId}/contact`).query({ recipientCanonicalUserId: buyer });
  expect(notYetApproved.status).toBe(403);

  await request(app).post(`/matches/${matchId}/approve`).send({ recipientCanonicalUserId: buyer });
  const afterApproval = await request(app).get(`/matches/${matchId}/contact`).query({ recipientCanonicalUserId: buyer });
  expect(afterApproval.status).toBe(200);
  expect(afterApproval.body.contactMethods[0].value).toBe('+1-route-seller');
  void seller;
});
