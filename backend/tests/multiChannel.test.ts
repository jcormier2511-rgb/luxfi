import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { MultiChannelAdapter } from '../src/adapters/multiChannel.adapter';
import { MessagingAdapter, OutboundMessage, SendResult } from '../src/adapters/messaging.adapter';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { addPlatformIdentityToCanonicalUser } from '../src/services/canonicalUser.service';

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

class RecordingAdapter implements MessagingAdapter {
  public sent: OutboundMessage[] = [];
  constructor(private readonly result: SendResult = { ok: true }) {}
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.result;
  }
}

test('routes to the recipient\'s only available channel', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'telegram', platformUserId: 'tg-only' });
  const telegram = new RecordingAdapter();
  const sms = new RecordingAdapter();
  const router = new MultiChannelAdapter(pool, { telegram, sms });

  const result = await router.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(true);
  expect(telegram.sent.length).toBe(1);
  expect(sms.sent.length).toBe(0);
});

test('prefers whatsapp over telegram/sms/email when a recipient has several identities', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'telegram', platformUserId: 'multi-tg' });
  await addPlatformIdentityToCanonicalUser(pool, identity.canonicalUserId, { platform: 'whatsapp', platformUserId: 'multi-wa' });
  await addPlatformIdentityToCanonicalUser(pool, identity.canonicalUserId, { platform: 'email', platformUserId: 'multi@example.com' });

  const whatsapp = new RecordingAdapter();
  const telegram = new RecordingAdapter();
  const email = new RecordingAdapter();
  const router = new MultiChannelAdapter(pool, { whatsapp, telegram, email });

  await router.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hi' });
  expect(whatsapp.sent.length).toBe(1);
  expect(telegram.sent.length).toBe(0);
  expect(email.sent.length).toBe(0);
});

test('falls back to the next available channel when the preferred one fails', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'fallback-wa' });
  await addPlatformIdentityToCanonicalUser(pool, identity.canonicalUserId, { platform: 'sms', platformUserId: '+15550009999' });

  const whatsapp = new RecordingAdapter({ ok: false, error: 'WhatsApp API 500: boom' });
  const sms = new RecordingAdapter({ ok: true });
  const router = new MultiChannelAdapter(pool, { whatsapp, sms });

  const result = await router.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(true);
  expect(whatsapp.sent.length).toBe(1);
  expect(sms.sent.length).toBe(1);
});

test('fails with a clear error when the recipient has no identity on a configured channel', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'email', platformUserId: 'unrouted@example.com' });
  const whatsapp = new RecordingAdapter();
  const router = new MultiChannelAdapter(pool, { whatsapp });

  const result = await router.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(false);
  expect(whatsapp.sent.length).toBe(0);
});
