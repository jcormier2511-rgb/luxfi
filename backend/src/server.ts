import 'dotenv/config';
import { Pool } from 'pg';
import { createApp } from './app';
import { runMigrations } from './db/migrate';
import { runFsSync, runWtbSync } from './services/sync.service';
import { reconcileMatches } from './services/matching.service';
import { runMonitorLifecycleJob } from './services/monitor.service';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const applied = await runMigrations(pool);
  if (applied.length) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied: ${applied.join(', ')}`);
  }

  // Refresh on startup (spec section 13), independently for FS and WTB.
  await runFsSync(pool).catch((err) => console.error('[sync:FS] startup sync failed', err));
  await runWtbSync(pool).catch((err) => console.error('[sync:WTB] startup sync failed', err));

  const fsSyncIntervalMs = Number(process.env.FS_SYNC_INTERVAL_MS ?? '90000');
  setInterval(() => {
    runFsSync(pool).catch((err) => console.error('[sync:FS] periodic sync failed', err));
    runWtbSync(pool).catch((err) => console.error('[sync:WTB] periodic sync failed', err));
  }, fsSyncIntervalMs);

  // Periodic reconciliation recovers matches missed by the immediate event path
  // (spec section 4.3, acceptance test 16).
  setInterval(() => {
    reconcileMatches(pool).catch((err) => console.error('[reconcile] periodic run failed', err));
  }, Number(process.env.RECONCILIATION_INTERVAL_MS ?? '300000'));

  setInterval(() => {
    runMonitorLifecycleJob(pool).catch((err) => console.error('[monitor-lifecycle] periodic run failed', err));
  }, Number(process.env.MONITOR_LIFECYCLE_INTERVAL_MS ?? '3600000'));

  const app = createApp(pool);
  const port = Number(process.env.PORT ?? '3000');
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Fi backend listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
