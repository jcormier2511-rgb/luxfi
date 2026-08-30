import crypto from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { verifyTwilioSignature, TwilioSmsAdapter } from '../src/adapters/sms.client';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { ingestApiPosting } from '../src/services/posting.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

const AUTH_TOKEN = 'test-twilio-auth-token';
const WEBHOOK_BASE_URL = 'https://fi.example.test';

let pool: Pool;

beforeAll(async () => {
  pool = await getTestPool();
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_WEBHOOK_BASE_URL = WEBHOOK_BASE_URL;
});

beforeEach(() => {
  setMessagingAdapter(new StubMessagingAdapter());
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;
});

function sign(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

function post(path: string, params: Record<string, string>) {
  const url = `${WEBHOOK_BASE_URL}${path}`;
  return request(createApp(pool)).post(path).set('x-twilio-signature', sign(url, params)).type('form').send(params);
}

test('verifyTwilioSignature rejects a tampered param set and a missing header', () => {
  const url = `${WEBHOOK_BASE_URL}/webhook/sms/`;
  const params = { From: '+15551234567', Body: 'hello' };
  const goodSig = sign(url, params);
  expect(verifyTwilioSignature(url, params, goodSig, AUTH_TOKEN)).toBe(true);
  expect(verifyTwilioSignature(url, { ...params, Body: 'tampered' }, goodSig, AUTH_TOKEN)).toBe(false);
  expect(verifyTwilioSignature(url, params, undefined, AUTH_TOKEN)).toBe(false);
});

test('POST webhook rejects an unsigned or badly signed request', async () => {
  const app = createApp(pool);
  const params = { From: '+15559876543', Body: 'FS Rolex 116500LN $18500', MessageSid: 'SM1' };

  const noSig = await request(app).post('/webhook/sms').type('form').send(params);
  expect(noSig.status).toBe(401);

  const badSig = await request(app)
    .post('/webhook/sms')
    .set('x-twilio-signature', 'bogus')
    .type('form')
    .send(params);
  expect(badSig.status).toBe(401);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('a correctly signed inbound FS text message creates a posting and matches an existing WTB', async () => {
  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'sms',
    platformUserId: '+15550001111',
  });
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: 'wtb-sms-preexisting',
    ownerCanonicalUserId: buyer.canonicalUserId,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, wtb.id, true);

  const params = { From: '+15559998888', Body: 'FS Rolex Daytona 116500LN $18500', MessageSid: 'SM2' };
  const res = await post('/webhook/sms', params);
  expect(res.status).toBe(200);

  await new Promise((r) => setTimeout(r, 300));

  const { rows: postings } = await pool.query(
    "SELECT * FROM postings WHERE source_platform = 'sms' AND source_message_id = 'SM2'"
  );
  expect(postings.length).toBe(1);
  expect(postings[0].posting_type).toBe('FS');

  const { rows: matches } = await pool.query('SELECT COUNT(*)::int AS c FROM matches WHERE fs_posting_id = $1', [
    postings[0].id,
  ]);
  expect(matches[0].c).toBe(1);
});

test('replying APPROVE resolves to the sender\'s most recent pending match', async () => {
  const seller = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'sms', platformUserId: '+15551110000' });
  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'buyer-sms-test' });

  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: 'fs-sms-approve',
    ownerCanonicalUserId: seller.canonicalUserId,
    referenceNumber: '116500LN',
    askingPrice: 18500,
  });
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: 'wtb-sms-approve',
    ownerCanonicalUserId: buyer.canonicalUserId,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { rows: matchRows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  const matchId = matchRows[0].id;
  await pool.query(`UPDATE match_recipients SET delivered_at = now() WHERE match_id = $1`, [matchId]);

  const res = await post('/webhook/sms', { From: '+15551110000', Body: 'approve', MessageSid: 'SM3' });
  expect(res.status).toBe(200);

  await new Promise((r) => setTimeout(r, 200));

  const { rows: approvals } = await pool.query(
    'SELECT * FROM approvals WHERE match_id = $1 AND approving_canonical_user_id = $2',
    [matchId, seller.canonicalUserId]
  );
  expect(approvals.length).toBe(1);
});

test('an unrecognizable text message is ignored (no posting created)', async () => {
  const res = await post('/webhook/sms', { From: '+15552223333', Body: 'anyone going to the watch fair?', MessageSid: 'SM4' });
  expect(res.status).toBe(200);

  await new Promise((r) => setTimeout(r, 200));
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('TwilioSmsAdapter.send looks up the recipient phone number and posts a form-encoded payload', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'sms', platformUserId: '+15553334444' });

  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TwilioSmsAdapter(pool, 'AC123', 'authtoken', '+15550000000');
    const result = await adapter.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hello' });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/Accounts/AC123/Messages.json');
    const params = new URLSearchParams(calls[0].init.body as string);
    expect(params.get('To')).toBe('+15553334444');
    expect(params.get('Body')).toBe('hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TwilioSmsAdapter.send renders buttons as a reply instruction and fails gracefully with no identity', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'sms', platformUserId: '+15554445555' });
  const originalFetch = global.fetch;
  let capturedBody = '';
  global.fetch = (async (_url: string, init: RequestInit) => {
    capturedBody = init.body as string;
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TwilioSmsAdapter(pool, 'AC123', 'authtoken', '+15550000000');
    await adapter.send({
      recipientCanonicalUserId: identity.canonicalUserId,
      text: 'Potential match',
      buttons: [
        { label: 'Approve match', action: 'approve:m1' },
        { label: 'Pass', action: 'pass:m1' },
      ],
    });
    const params = new URLSearchParams(capturedBody);
    expect(params.get('Body')).toContain('Reply "Approve match"');
    expect(params.get('Body')).toContain('Reply "Pass"');
  } finally {
    global.fetch = originalFetch;
  }

  const orphan = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'wa-only-sms-test' });
  const adapter = new TwilioSmsAdapter(pool, 'AC123', 'authtoken', '+15550000000');
  const result = await adapter.send({ recipientCanonicalUserId: orphan.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(false);
});
