import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { reconcileMatches } from '../src/services/matching.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

const ADMIN_TOKEN = 'test-admin-token-admin-suite';
let pool: Pool;
let idCounter = 0;

beforeAll(async () => {
  pool = await getTestPool();
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
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

test('admin status is unreachable without a token and available with one', async () => {
  const app = createApp(pool);
  const noToken = await request(app).get('/admin/status');
  expect(noToken.status).toBe(401);

  const withToken = await request(app).get('/admin/status').set('x-admin-token', ADMIN_TOKEN);
  expect(withToken.status).toBe(200);
  expect(withToken.body.databaseOk).toBe(true);
  expect(withToken.body.migrations.appliedCount).toBeGreaterThanOrEqual(4);
  expect(withToken.body.migrations.pendingCount).toBe(0);
});

test('admin status reports the last reconciliation run and clears its error on the next success', async () => {
  const app = createApp(pool);

  await reconcileMatches(pool);
  const afterFirst = await request(app).get('/admin/status').set('x-admin-token', ADMIN_TOKEN);
  expect(afterFirst.body.lastReconciliationRunAt).not.toBeNull();
  expect(afterFirst.body.lastReconciliationError).toBeNull();

  const brokenPool = { query: () => Promise.reject(new Error('boom')) } as unknown as Pool;
  await expect(reconcileMatches(brokenPool)).rejects.toThrow('boom');

  const afterFailure = await request(app).get('/admin/status').set('x-admin-token', ADMIN_TOKEN);
  expect(afterFailure.body.lastReconciliationError).toBe('boom');

  await reconcileMatches(pool);
  const afterRecovery = await request(app).get('/admin/status').set('x-admin-token', ADMIN_TOKEN);
  expect(afterRecovery.body.lastReconciliationError).toBeNull();
});

test('admin routes are unreachable (503), not open, when ADMIN_API_TOKEN is unset', async () => {
  const app = createApp(pool);
  const original = process.env.ADMIN_API_TOKEN;
  delete process.env.ADMIN_API_TOKEN;
  try {
    const res = await request(app).get('/admin/status');
    expect(res.status).toBe(503);
  } finally {
    process.env.ADMIN_API_TOKEN = original;
  }
});

test('entitlement-override requires enabled + adminActor and actually flips the gate', async () => {
  const app = createApp(pool);
  idCounter += 1;
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `admin-route-user-${idCounter}`,
  });

  const badRequest = await request(app)
    .post(`/admin/users/${identity.canonicalUserId}/entitlement-override`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ enabled: true }); // missing adminActor
  expect(badRequest.status).toBe(400);

  const ok = await request(app)
    .post(`/admin/users/${identity.canonicalUserId}/entitlement-override`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ enabled: true, adminActor: 'admin@luxfi.test', reason: 'early access' });
  expect(ok.status).toBe(200);
  expect(ok.body.manualOverrideEnabled).toBe(true);
  expect(ok.body.fiMembershipStatus).toBe('active');

  const { rows } = await pool.query(
    'SELECT manual_override_enabled, manual_override_by FROM membership_entitlements WHERE canonical_user_id = $1',
    [identity.canonicalUserId]
  );
  expect(rows[0].manual_override_enabled).toBe(true);
  expect(rows[0].manual_override_by).toBe('admin@luxfi.test');
});

test('watchfacts-verify marks manual verification and waives the Fi membership fee', async () => {
  const app = createApp(pool);
  idCounter += 1;
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `admin-route-wf-${idCounter}`,
  });

  const badRequest = await request(app)
    .post(`/admin/users/${identity.canonicalUserId}/watchfacts-verify`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({}); // missing verified + adminActor
  expect(badRequest.status).toBe(400);

  const ok = await request(app)
    .post(`/admin/users/${identity.canonicalUserId}/watchfacts-verify`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ verified: true, adminActor: 'admin@luxfi.test' });
  expect(ok.status).toBe(200);
  expect(ok.body.watchFactsMemberVerified).toBe(true);
  expect(ok.body.watchFactsVerificationSource).toBe('manual_admin');
  expect(ok.body.fiMembershipStatus).toBe('waived_via_watchfacts');
});

test('sync/fs, sync/wtb, and reconcile admin routes return their service results', async () => {
  const app = createApp(pool);

  const fs = await request(app).post('/admin/sync/fs').set('x-admin-token', ADMIN_TOKEN);
  expect(fs.status).toBe(200);
  expect(['ok', 'error', 'disabled']).toContain(fs.body.status);

  const wtb = await request(app).post('/admin/sync/wtb').set('x-admin-token', ADMIN_TOKEN);
  expect(wtb.status).toBe(200);
  expect(wtb.body.status).toBe('disabled'); // ENABLE_WTB_SYNC is false by default

  const reconcile = await request(app).post('/admin/reconcile').set('x-admin-token', ADMIN_TOKEN);
  expect(reconcile.status).toBe(200);
  expect(typeof reconcile.body.postingsScanned).toBe('number');
});

test('merge-into route links a provisional identity into a target account', async () => {
  const app = createApp(pool);
  idCounter += 1;
  const from = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `merge-route-from-${idCounter}`,
  });
  const to = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `merge-route-to-${idCounter}`,
  });

  const sameId = await request(app)
    .post(`/admin/users/${from.canonicalUserId}/merge-into/${from.canonicalUserId}`)
    .set('x-admin-token', ADMIN_TOKEN);
  expect(sameId.status).toBe(400);

  const ok = await request(app)
    .post(`/admin/users/${from.canonicalUserId}/merge-into/${to.canonicalUserId}`)
    .set('x-admin-token', ADMIN_TOKEN);
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ status: 'merged', from: from.canonicalUserId, into: to.canonicalUserId });

  const { rows } = await pool.query('SELECT merged_into_id FROM canonical_users WHERE id = $1', [from.canonicalUserId]);
  expect(rows[0].merged_into_id).toBe(to.canonicalUserId);
});

test('platform-identity route attaches a new channel identity, is idempotent, and rejects stealing one already linked elsewhere', async () => {
  const app = createApp(pool);
  idCounter += 1;
  const owner = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `platform-identity-owner-${idCounter}`,
  });
  const other = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `platform-identity-other-${idCounter}`,
  });

  const badRequest = await request(app)
    .post(`/admin/users/${owner.canonicalUserId}/platform-identity`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ platform: 'carrier-pigeon', platformUserId: 'x' });
  expect(badRequest.status).toBe(400);

  const email = `member-${idCounter}@example.com`;
  const added = await request(app)
    .post(`/admin/users/${owner.canonicalUserId}/platform-identity`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ platform: 'email', platformUserId: email });
  expect(added.status).toBe(200);
  expect(added.body).toEqual({ status: 'added' });

  const idempotent = await request(app)
    .post(`/admin/users/${owner.canonicalUserId}/platform-identity`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ platform: 'email', platformUserId: email });
  expect(idempotent.status).toBe(200);
  expect(idempotent.body).toEqual({ status: 'already_linked' });

  const conflict = await request(app)
    .post(`/admin/users/${other.canonicalUserId}/platform-identity`)
    .set('x-admin-token', ADMIN_TOKEN)
    .send({ platform: 'email', platformUserId: email });
  expect(conflict.status).toBe(409);
  expect(conflict.body.existingCanonicalUserId).toBe(owner.canonicalUserId);

  const { rows } = await pool.query(
    "SELECT canonical_user_id FROM platform_identities WHERE platform = 'email' AND platform_user_id = $1",
    [email]
  );
  expect(rows[0].canonical_user_id).toBe(owner.canonicalUserId);
});
