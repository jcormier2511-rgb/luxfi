import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMonitorLifecycleJob } from '../src/services/monitor.service';
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

async function makePosting(ownerId: string) {
  idCounter += 1;
  return ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `lifecycle-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: ownerId,
  });
}

test('a posting inside the reminder window gets a reminder and is marked sent, exactly once', async () => {
  const owner = await makeUser();
  const { posting } = await makePosting(owner);
  await pool.query("UPDATE postings SET expires_at = now() + interval '2 days' WHERE id = $1", [posting.id]);

  const first = await runMonitorLifecycleJob(pool);
  expect(first.remindersSent).toBe(1);
  expect(stub.sent.some((m) => m.recipientCanonicalUserId === owner && m.text.includes('extend'))).toBe(true);

  const { rows } = await pool.query('SELECT extension_reminder_sent_at FROM postings WHERE id = $1', [posting.id]);
  expect(rows[0].extension_reminder_sent_at).not.toBeNull();

  // Running again must not re-send the same reminder.
  stub.sent = [];
  const second = await runMonitorLifecycleJob(pool);
  expect(second.remindersSent).toBe(0);
  expect(stub.sent.length).toBe(0);
});

test('a posting well outside the reminder window gets no reminder', async () => {
  const owner = await makeUser();
  const { posting } = await makePosting(owner);
  await pool.query("UPDATE postings SET expires_at = now() + interval '20 days' WHERE id = $1", [posting.id]);

  const result = await runMonitorLifecycleJob(pool);
  expect(result.remindersSent).toBe(0);
  const { rows } = await pool.query('SELECT extension_reminder_sent_at FROM postings WHERE id = $1', [posting.id]);
  expect(rows[0].extension_reminder_sent_at).toBeNull();
});

test('an overdue active posting is expired by the lifecycle job', async () => {
  const owner = await makeUser();
  const { posting } = await makePosting(owner);
  await pool.query("UPDATE postings SET expires_at = now() - interval '1 hour' WHERE id = $1", [posting.id]);

  const result = await runMonitorLifecycleJob(pool);
  expect(result.expired).toBeGreaterThanOrEqual(1);
  const { rows } = await pool.query('SELECT status FROM postings WHERE id = $1', [posting.id]);
  expect(rows[0].status).toBe('expired');
});
