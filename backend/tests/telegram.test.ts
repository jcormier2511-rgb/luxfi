import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { verifyTelegramSecret, TelegramBotAdapter } from '../src/adapters/telegram.client';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { ingestApiPosting } from '../src/services/posting.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

const WEBHOOK_SECRET = 'test-telegram-secret';

let pool: Pool;

beforeAll(async () => {
  pool = await getTestPool();
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(() => {
  setMessagingAdapter(new StubMessagingAdapter());
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

function textUpdate(chatId: number, text: string, messageId = 1, from?: { id: number; first_name?: string }) {
  return {
    update_id: 100 + messageId,
    message: {
      message_id: messageId,
      from: from ?? { id: chatId, first_name: 'Test User' },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

test('verifyTelegramSecret rejects a missing/wrong header and accepts the correct one', () => {
  expect(verifyTelegramSecret(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true);
  expect(verifyTelegramSecret('wrong', WEBHOOK_SECRET)).toBe(false);
  expect(verifyTelegramSecret(undefined, WEBHOOK_SECRET)).toBe(false);
});

test('POST webhook rejects a request with a missing or wrong secret header', async () => {
  const app = createApp(pool);
  const payload = textUpdate(555111, 'FS Rolex 116500LN $18500');

  const noSecret = await request(app).post('/webhook/telegram').send(payload);
  expect(noSecret.status).toBe(401);

  const wrongSecret = await request(app)
    .post('/webhook/telegram')
    .set('x-telegram-bot-api-secret-token', 'wrong')
    .send(payload);
  expect(wrongSecret.status).toBe(401);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('a correctly authenticated inbound FS text message creates a posting and matches an existing WTB', async () => {
  const app = createApp(pool);

  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'telegram',
    platformUserId: '778899',
  });
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: 'wtb-telegram-preexisting',
    ownerCanonicalUserId: buyer.canonicalUserId,
    referenceNumber: '116500LN',
    maxBid: 20000,
  });
  await runMatchingForPosting(pool, wtb.id, true);

  const payload = textUpdate(445566, 'FS Rolex Daytona 116500LN $18500', 2);
  const res = await request(app)
    .post('/webhook/telegram')
    .set('x-telegram-bot-api-secret-token', WEBHOOK_SECRET)
    .send(payload);
  expect(res.status).toBe(200);

  await new Promise((r) => setTimeout(r, 300));

  const { rows: postings } = await pool.query(
    "SELECT * FROM postings WHERE source_platform = 'telegram' AND source_message_id = '2'"
  );
  expect(postings.length).toBe(1);
  expect(postings[0].posting_type).toBe('FS');

  const { rows: matches } = await pool.query('SELECT COUNT(*)::int AS c FROM matches WHERE fs_posting_id = $1', [
    postings[0].id,
  ]);
  expect(matches[0].c).toBe(1);
});

test('an unrecognizable text message is ignored (no posting created)', async () => {
  const app = createApp(pool);
  const payload = textUpdate(112233, 'anyone going to the watch fair?', 3);
  await request(app)
    .post('/webhook/telegram')
    .set('x-telegram-bot-api-secret-token', WEBHOOK_SECRET)
    .send(payload);

  await new Promise((r) => setTimeout(r, 200));
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(0);
});

test('a callback_query approves the referenced match', async () => {
  const app = createApp(pool);

  const seller = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'telegram',
    platformUserId: '990011',
  });
  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'buyer-x' });

  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: 'fs-telegram-callback',
    ownerCanonicalUserId: seller.canonicalUserId,
    referenceNumber: '116500LN',
    askingPrice: 18500,
  });
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: 'wtb-telegram-callback',
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

  const callbackUpdate = {
    update_id: 500,
    callback_query: {
      id: 'cb-1',
      from: { id: 990011, first_name: 'Seller' },
      data: `approve:${matchId}`,
    },
  };
  const res = await request(app)
    .post('/webhook/telegram')
    .set('x-telegram-bot-api-secret-token', WEBHOOK_SECRET)
    .send(callbackUpdate);
  expect(res.status).toBe(200);

  await new Promise((r) => setTimeout(r, 200));

  const { rows: approvals } = await pool.query(
    'SELECT * FROM approvals WHERE match_id = $1 AND approving_canonical_user_id = $2',
    [matchId, seller.canonicalUserId]
  );
  expect(approvals.length).toBe(1);
});

test('TelegramBotAdapter.send looks up the recipient chat id and posts a text payload', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'telegram',
    platformUserId: '112358',
  });

  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ ok: true }), text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TelegramBotAdapter(pool, 'bot-token-123');
    const result = await adapter.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hello' });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('bot-token-123/sendMessage');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.chat_id).toBe('112358');
    expect(body.text).toBe('hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TelegramBotAdapter.send fails gracefully when the recipient has no Telegram identity on file', async () => {
  const orphan = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'wa-only-user' });
  const adapter = new TelegramBotAdapter(pool, 'bot-token');
  const result = await adapter.send({ recipientCanonicalUserId: orphan.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(false);
});
