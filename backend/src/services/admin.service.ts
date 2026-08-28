import { Pool } from 'pg';
import { getSyncStatus } from './sync.service';

export interface AdminStatus {
  sync: Record<string, unknown>[];
  chatOriginatedActiveFsCount: number;
  chatOriginatedActiveWtbCount: number;
  totalActiveMonitors: number;
  totalActiveMatches: number;
  notificationsSent: number;
  notificationsFailed: number;
  lastReconciliationRunAt: string | null;
  databaseOk: boolean;
}

/**
 * Protected inventory/matching status snapshot (spec section 14). Never
 * includes credentials, tokens, or database URLs -- only counts and
 * timestamps.
 */
export async function getAdminStatus(pool: Pool): Promise<AdminStatus> {
  const [sync, chatFs, chatWtb, monitors, matches, notifOk, notifFail, dbCheck] = await Promise.all([
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
  ]);

  return {
    sync,
    chatOriginatedActiveFsCount: chatFs.rows[0].c,
    chatOriginatedActiveWtbCount: chatWtb.rows[0].c,
    totalActiveMonitors: monitors.rows[0].c,
    totalActiveMatches: matches.rows[0].c,
    notificationsSent: notifOk.rows[0].c,
    notificationsFailed: notifFail.rows[0].c,
    lastReconciliationRunAt: null,
    databaseOk: dbCheck,
  };
}
