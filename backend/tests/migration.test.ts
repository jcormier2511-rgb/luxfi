import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

const baseConnectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const url = new URL(baseConnectionString);
const maintenanceConnectionString = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

async function createDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: maintenanceConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: maintenanceConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function connectionStringFor(name: string): string {
  return `${url.protocol}//${url.username}:${url.password}@${url.host}/${name}`;
}

test('39. the migration succeeds on an empty database', async () => {
  const dbName = 'fi_test_migration_empty';
  await createDatabase(dbName);
  const pool = new Pool({ connectionString: connectionStringFor(dbName) });
  try {
    const applied = await runMigrations(pool);
    expect(applied).toEqual([
      '001_legacy_sync_meta_baseline.sql',
      '002_core_schema.sql',
      '003_sync_meta_additive.sql',
      '004_introduction_delivery_tracking.sql',
      '005_dealer_vouches.sql',
    ]);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual(
      expect.arrayContaining(['canonical_users', 'postings', 'matches', 'sync_meta', 'membership_entitlements'])
    );
  } finally {
    await pool.end();
    await dropDatabase(dbName);
  }
});

test('40 & 41. the migration succeeds against an existing legacy sync_meta schema and preserves all legacy columns', async () => {
  const dbName = 'fi_test_migration_legacy';
  await createDatabase(dbName);
  const pool = new Pool({ connectionString: connectionStringFor(dbName) });
  try {
    // Simulate a pre-existing production sync_meta table, created outside our
    // migration system, with real historical data already in it.
    await pool.query(`
      CREATE TABLE sync_meta (
        id SERIAL PRIMARY KEY,
        sync_type TEXT NOT NULL UNIQUE,
        last_sync_at TIMESTAMPTZ,
        last_sync_status TEXT,
        last_sync_error TEXT,
        sync_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `INSERT INTO sync_meta (sync_type, last_sync_status, sync_count) VALUES ('FS', 'ok', 5)`
    );

    await expect(runMigrations(pool)).resolves.toEqual([
      '001_legacy_sync_meta_baseline.sql',
      '002_core_schema.sql',
      '003_sync_meta_additive.sql',
      '004_introduction_delivery_tracking.sql',
      '005_dealer_vouches.sql',
    ]);

    const { rows: columns } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sync_meta'`
    );
    const columnNames = columns.map((c) => c.column_name);
    for (const legacyColumn of ['last_sync_at', 'last_sync_status', 'last_sync_error', 'sync_count']) {
      expect(columnNames).toContain(legacyColumn);
    }
    for (const newColumn of ['last_attempt_at', 'active_count', 'enabled']) {
      expect(columnNames).toContain(newColumn);
    }

    // Pre-existing production data must survive the additive migration untouched.
    const { rows } = await pool.query(`SELECT sync_count, last_sync_status FROM sync_meta WHERE sync_type = 'FS'`);
    expect(rows[0].sync_count).toBe(5);
    expect(rows[0].last_sync_status).toBe('ok');
  } finally {
    await pool.end();
    await dropDatabase(dbName);
  }
});
