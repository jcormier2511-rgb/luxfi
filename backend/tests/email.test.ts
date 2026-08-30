import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { SendGridEmailAdapter } from '../src/adapters/email.client';
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

test('SendGridEmailAdapter.send looks up the recipient email and posts to the v3 mail-send API', async () => {
  const seller = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'seller-email-test' });
  await addPlatformIdentityToCanonicalUser(pool, seller.canonicalUserId, {
    platform: 'email',
    platformUserId: 'seller@example.com',
  });

  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => ({}), text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const adapter = new SendGridEmailAdapter(pool, 'sg-key', 'fi@luxfi.test');
    const result = await adapter.send({ recipientCanonicalUserId: seller.canonicalUserId, text: 'You have a new match!' });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/v3/mail/send');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.personalizations[0].to[0].email).toBe('seller@example.com');
    expect(body.from.email).toBe('fi@luxfi.test');
    expect(body.content[0].value).toBe('You have a new match!');
  } finally {
    global.fetch = originalFetch;
  }
});

test('SendGridEmailAdapter.send renders buttons as reply instructions and fails gracefully with no identity', async () => {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'no-email-user' });
  const adapter = new SendGridEmailAdapter(pool, 'sg-key', 'fi@luxfi.test');
  const result = await adapter.send({ recipientCanonicalUserId: identity.canonicalUserId, text: 'hi' });
  expect(result.ok).toBe(false);
});

test('SendGridEmailAdapter.send surfaces a non-2xx SendGrid response as a failure', async () => {
  const buyer = await resolveCanonicalUserForPlatformIdentity(pool, { platform: 'whatsapp', platformUserId: 'buyer-email-test' });
  await addPlatformIdentityToCanonicalUser(pool, buyer.canonicalUserId, { platform: 'email', platformUserId: 'buyer@example.com' });

  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response)) as typeof fetch;

  try {
    const adapter = new SendGridEmailAdapter(pool, 'bad-key', 'fi@luxfi.test');
    const result = await adapter.send({
      recipientCanonicalUserId: buyer.canonicalUserId,
      text: 'Potential match',
      buttons: [{ label: 'Approve match', action: 'approve:m1' }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  } finally {
    global.fetch = originalFetch;
  }
});
