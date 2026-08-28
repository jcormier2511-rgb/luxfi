import crypto from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

const APP_SECRET = 'test-app-secret-2';
let pool: Pool;
let stub: StubMessagingAdapter;

beforeAll(async () => {
  pool = await getTestPool();
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-2';
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
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
});

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

async function postSigned(app: import('express').Express, payload: unknown) {
  const bodyStr = JSON.stringify(payload);
  return request(app)
    .post('/webhook/whatsapp')
    .set('x-hub-signature-256', sign(bodyStr))
    .set('Content-Type', 'application/json')
    .send(bodyStr);
}

function textPayload(from: string, text: string, messageId: string) {
  return {
    entry: [
      { changes: [{ value: { contacts: [{ profile: { name: 'Test User' }, wa_id: from }], messages: [{ from, id: messageId, type: 'text', text: { body: text } }] } }] },
    ],
  };
}

function buttonPayload(from: string, buttonId: string, messageId: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
              messages: [{ from, id: messageId, type: 'interactive', interactive: { type: 'button', button_reply: { id: buttonId, title: 'x' } } }],
            },
          },
        ],
      },
    ],
  };
}

test('"extend" with no pending reminder gets a friendly no-op reply', async () => {
  const app = createApp(pool);
  await postSigned(app, textPayload('15551110001', 'extend', 'wamid.e1'));
  await new Promise((r) => setTimeout(r, 200));

  const reply = stub.sent.find((m) => m.text.includes("don't see a monitor"));
  expect(reply).toBeDefined();
});

test('"extend" pushes out expires_at for postings with a reminder already sent', async () => {
  const app = createApp(pool);
  const owner = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: '15551110002' });
  const { posting } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: 'ext-1',
    ownerCanonicalUserId: owner.canonicalUserId,
  });
  await pool.query('UPDATE postings SET extension_reminder_sent_at = now() WHERE id = $1', [posting.id]);
  const before = (await pool.query('SELECT expires_at FROM postings WHERE id = $1', [posting.id])).rows[0].expires_at;

  await postSigned(app, textPayload('15551110002', 'extend', 'wamid.e2'));
  await new Promise((r) => setTimeout(r, 200));

  const { rows } = await pool.query(
    'SELECT expires_at, extension_reminder_sent_at FROM postings WHERE id = $1',
    [posting.id]
  );
  expect(new Date(rows[0].expires_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  expect(rows[0].extension_reminder_sent_at).toBeNull();
  expect(stub.sent.some((m) => m.text.startsWith('Extended!'))).toBe(true);
});

test('"join" text command sends the keep-working acknowledgment', async () => {
  const app = createApp(pool);
  await postSigned(app, textPayload('15551110003', 'join', 'wamid.j1'));
  await new Promise((r) => setTimeout(r, 200));
  expect(stub.sent.some((m) => m.text.includes('admin will enable billing'))).toBe(true);
});

test('the "Keep Fi working for me" button also triggers the acknowledgment', async () => {
  const app = createApp(pool);
  await postSigned(app, buttonPayload('15551110004', 'keep-working', 'wamid.k1'));
  await new Promise((r) => setTimeout(r, 200));
  expect(stub.sent.some((m) => m.text.includes('admin will enable billing'))).toBe(true);
});
