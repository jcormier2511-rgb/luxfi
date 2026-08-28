import { Pool } from 'pg';
import { getSyncStatus } from './sync.service';
import { getReconciliationStatus } from './matching.service';
import { getMigrationStatus, MigrationStatus } from '../db/migrate';

export interface AdminStatus {
  sync: Record<string, unknown>[];
  chatOriginatedActiveFsCount: number;
  chatOriginatedActiveWtbCount: number;
  totalActiveMonitors: number;
  totalActiveMatches: number;
  notificationsSent: number;
  notificationsFailed: number;
  lastReconciliationRunAt: string | null;
  lastReconciliationError: string | null;
  databaseOk: boolean;
  migrations: MigrationStatus | null;
}

/**
 * Protected inventory/matching status snapshot (spec section 14). Never
 * includes credentials, tokens, or database URLs -- only counts and
 * timestamps.
 */
export async function getAdminStatus(pool: Pool): Promise<AdminStatus> {
  const [sync, chatFs, chatWtb, monitors, matches, notifOk, notifFail, dbCheck, migrations] = await Promise.all([
    getSyncStatus(pool),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM postings WHERE source_type = 'chat' AND posting_type = 'FS' AND status = 'active'`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM postings WHERE source_type = 'chat' AND posting_type = 'WTB' AND status = 'active'`
    ),
    pool.query(`SELECT COUNT(*)::int AS c FROM postings WHERE status = 'active'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM matches WHERE status IN ('surfaced', 'approved')`),
    pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE status = 'sent'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM notifications WHERE status = 'failed'`),
    pool.query('SELECT 1').then(() => true).catch(() => false),
    getMigrationStatus(pool).catch(() => null),
  ]);

  const reconciliation = getReconciliationStatus();

  return {
    sync,
    chatOriginatedActiveFsCount: chatFs.rows[0].c,
    chatOriginatedActiveWtbCount: chatWtb.rows[0].c,
    totalActiveMonitors: monitors.rows[0].c,
    totalActiveMatches: matches.rows[0].c,
    notificationsSent: notifOk.rows[0].c,
    notificationsFailed: notifFail.rows[0].c,
    lastReconciliationRunAt: reconciliation.lastRunAt ? reconciliation.lastRunAt.toISOString() : null,
    lastReconciliationError: reconciliation.lastRunError,
    databaseOk: dbCheck,
    migrations,
  };
}
