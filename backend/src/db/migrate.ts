import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

export interface MigrationStatus {
  appliedCount: number;
  pendingCount: number;
  lastAppliedId: string | null;
  lastAppliedAt: Date | null;
}

/**
 * Migration status for the admin visibility endpoint (spec section 14:
 * "Database connectivity/migration status without exposing secrets").
 * Never includes connection strings or credentials -- only counts/ids.
 */
export async function getMigrationStatus(pool: Pool): Promise<MigrationStatus> {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const { rows } = await pool.query<{ id: string; applied_at: Date }>(
    'SELECT id, applied_at FROM schema_migrations ORDER BY applied_at DESC'
  );
  return {
    appliedCount: rows.length,
    pendingCount: Math.max(0, files.length - rows.length),
    lastAppliedId: rows[0]?.id ?? null,
    lastAppliedAt: rows[0]?.applied_at ?? null,
  };
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  runMigrations(pool)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return pool.end();
    });
}
