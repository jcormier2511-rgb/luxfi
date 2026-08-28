import request from 'supertest';
import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { createApp } from '../src/app';
import { reconcileMatches } from '../src/services/matching.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

const ADMIN_TOKEN = 'test-admin-token-admin-suite';
let pool: Pool;

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
