import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

let pool: Pool | undefined;

export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await runMigrations(pool);
  }
  return pool;
}

const APP_TABLES = [
  'notifications',
  'match_recipients',
  'approvals',
  'passes',
  'counterparty_confirmations',
  'introductions',
  'billing_ledger',
  'membership_entitlements',
  'matches',
  'posting_images',
  'postings',
  'platform_identities',
  'monitored_groups',
  'canonical_users',
];

export async function truncateAll(): Promise<void> {
  const p = await getTestPool();
  await p.query(`TRUNCATE ${APP_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  await p.query(
    `UPDATE sync_meta SET last_sync_at = NULL, last_sync_status = NULL, last_sync_error = NULL,
       sync_count = 0, last_attempt_at = NULL, active_count = 0,
       enabled = CASE WHEN sync_type = 'WTB' THEN false ELSE true END`
  );
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
