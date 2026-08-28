import crypto from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { verifyWhatsAppSignature, WhatsAppCloudAdapter } from '../src/adapters/whatsapp.client';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { ingestApiPosting } from '../src/services/posting.service';
import { runMatchingForPosting } from '../src/services/matching.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

let pool: Pool;

beforeAll(async () => {
  pool = await getTestPool();
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
});

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function textMessagePayload(from: string, name: string, text: string, messageId = 'wamid.1') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name }, wa_id: from }],
              messages: [{ from, id: messageId, type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

test('signature verification rejects a tampered body and accepts a correctly signed one', () => {
  const body = Buffer.from('{"hello":"world"}');
  const goodSig = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
  expect(verifyWhatsAppSignature(body, goodSig, APP_SECRET)).toBe(true);
  expect(verifyWhatsAppSignature(body, 'sha256=deadbeef', APP_SECRET)).toBe(false);
  expect(verifyWhatsAppSignature(body, undefined, APP_SECRET)).toBe(false);
  expect(verifyWhatsAppSignature(Buffer.from('{"hello":"tampered"}'), goodSig, APP_SECRET)).toBe(false);
});

test('GET webhook verification handshake', async () => {
  const app = createApp(pool);
  const ok = await request(app)
    .get('/webhook/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'echo-me' });
  expect(ok.status).toBe(200);
  expect(ok.text).toBe('echo-me');

  const bad = await request(app)
    .get('/webhook/whatsapp')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'echo-me' });
  expect(bad.status).toBe(403);
});

test('POST webhook rejects an unsigned or badly signed request', async () => {
  const app = createApp(pool);
  const payload = textMessagePayload('15551234567', 'Seller One', 'FS Rolex 116500LN $18500');

  const noSig = await request(app).post('/webhook/whatsapp').send(payload);
  expect(noSig.status).toBe(401);

  const badSig = await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', 'sha256=deadbeef')
    .send(payload);
  expect(badSig.status).toBe(401);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('a correctly signed inbound FS text message creates a posting and matches an existing WTB', async () => {
  const app = createApp(pool);

  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: 'buyer-wa-id',
  });
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: 'wtb-preexisting',
    ownerCanonicalUserId: buyer.canonicalUserId,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, wtb.id, true);

  const payload = textMessagePayload('15559876543', 'Seller One', 'FS Rolex Daytona 116500LN $18500');
  const bodyStr = JSON.stringify(payload);
  const res = await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', sign(bodyStr))
    .set('Content-Type', 'application/json')
    .send(bodyStr);
  expect(res.status).toBe(200);

  // Webhook processing continues after the 200 ack -- give it a moment.
  await new Promise((r) => setTimeout(r, 300));

  const { rows: postings } = await pool.query(
    "SELECT * FROM postings WHERE source_platform = 'whatsapp' AND source_message_id = 'wamid.1'"
  );
  expect(postings.length).toBe(1);
  expect(postings[0].posting_type).toBe('FS');
  expect(postings[0].reference_number).toBe('116500LN');

  const { rows: matches } = await pool.query('SELECT COUNT(*)::int AS c FROM matches WHERE fs_posting_id = $1', [
    postings[0].id,
  ]);
  expect(matches[0].c).toBe(1);
});

test('an unrecognizable text message is ignored (no posting created)', async () => {
  const app = createApp(pool);
  const payload = textMessagePayload('15550001111', 'Chatty Person', 'anyone going to the watch fair?', 'wamid.2');
  const bodyStr = JSON.stringify(payload);
  await request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', sign(bodyStr))
    .set('Content-Type', 'application/json')
    .send(bodyStr);

  await new Promise((r) => setTimeout(r, 200));
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('WhatsAppCloudAdapter.send looks up the recipient phone number and posts a text payload', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: '15551112222',
  });

  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const adapter = new WhatsAppCloudAdapter(pool, 'token-123', 'phone-id-456');
    const result = await adapter.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hello' });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('phone-id-456/messages');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.to).toBe('15551112222');
    expect(body.type).toBe('text');
    expect(body.text.body).toBe('hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('WhatsAppCloudAdapter.send fails gracefully when the recipient has no WhatsApp identity on file', async () => {
  const orphan = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'telegram',
    platformUserId: 'tg-only-user',
  });
  const adapter = new WhatsAppCloudAdapter(pool, 'token', 'phone-id');
  const result = await adapter.send({ recipientCanonicalUserId: orphan.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(false);
});
