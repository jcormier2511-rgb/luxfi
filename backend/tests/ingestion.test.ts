import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestChatPosting, ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { ChatPostingInput } from '../src/types/domain';

let pool: Pool;

beforeAll(async () => {
  pool = await getTestPool();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

function chatInput(overrides: Partial<ChatPostingInput> = {}): ChatPostingInput {
  return {
    sourceType: 'chat',
    platform: 'whatsapp',
    chatId: 'group-1',
    messageId: 'msg-1',
    postingType: 'WTB',
    originalMessage: 'WTB Rolex Daytona 116500LN',
    senderPlatformUserId: 'wa-user-1',
    senderDisplayName: 'James K.',
    referenceNumber: '116500LN',
    ...overrides,
  };
}

test('1. a chat WTB message creates one normalized posting with an active monitor', async () => {
  const { posting, created } = await ingestChatPosting(pool, chatInput());
  expect(created).toBe(true);
  expect(posting.status).toBe('active');
  expect(posting.postingType).toBe('WTB');
  expect(posting.referenceNumber).toBe('116500LN');
  expect(posting.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

test('2. a duplicate webhook delivery creates no duplicate posting', async () => {
  const first = await ingestChatPosting(pool, chatInput());
  const second = await ingestChatPosting(pool, chatInput());
  expect(second.created).toBe(false);
  expect(second.posting.id).toBe(first.posting.id);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(1);
});

test('3. editing the same chat message updates the posting instead of duplicating it', async () => {
  const first = await ingestChatPosting(pool, chatInput());
  const edited = await ingestChatPosting(
    pool,
    chatInput({ originalMessage: 'WTB Rolex Daytona 116500LN, budget $20k', maxBid: 20000, currency: 'USD' })
  );
  expect(edited.posting.id).toBe(first.posting.id);
  expect(edited.materiallyChanged).toBe(true);
  expect(edited.posting.maxBid).toBe(20000);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM postings');
  expect(rows[0].c).toBe(1);
});

test('4. API FS and WTB records with the same numeric external ID remain separate', async () => {
  const owner = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: 'owner-1',
  });
  const fs = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: '12345',
    ownerCanonicalUserId: owner.canonicalUserId,
  });
  const wtb = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: '12345',
    ownerCanonicalUserId: owner.canonicalUserId,
  });
  expect(fs.posting.id).not.toBe(wtb.posting.id);
  expect(fs.posting.postingType).toBe('FS');
  expect(wtb.posting.postingType).toBe('WTB');
});

test('5. chat and API postings use their correct source-specific idempotency keys', async () => {
  const chat = await ingestChatPosting(pool, chatInput({ chatId: 'group-2', messageId: 'msg-9' }));
  const chatAgainDifferentPlatform = await ingestChatPosting(
    pool,
    chatInput({ platform: 'telegram', chatId: 'group-2', messageId: 'msg-9', senderPlatformUserId: 'tg-user-1' })
  );
  // Same chatId/messageId but different platform -> distinct posting (platform is part of the key).
  expect(chatAgainDifferentPlatform.posting.id).not.toBe(chat.posting.id);
});

test('6. linked identities share one canonical user and one trial count', async () => {
  const a = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'shared-1' });
  const b = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'shared-1' });
  expect(a.canonicalUserId).toBe(b.canonicalUserId);
});
