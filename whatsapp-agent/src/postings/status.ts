import { withSchema } from "./db";

/**
 * Persists a notification delivery failure so it's actually visible somewhere (spec §14: admin
 * status must report "notifications sent and failed") — until now a failed sendText was only
 * ever console.error'd, with no queryable record at all. Never throws: called from notify.ts's
 * own catch blocks, so a failure recording its own failure must not compound the problem.
 */
export async function recordNotificationFailure(error: string): Promise<void> {
  try {
    await withSchema((pool) =>
      pool.query(
        `UPDATE postings_meta SET
           notifications_failed_count = notifications_failed_count + 1,
           last_notification_error = $1,
           last_notification_error_at = now()
         WHERE id = 1`,
        [error]
      )
    );
  } catch (err) {
    console.error("[postings] failed to record a notification failure (the original failure is still logged above):", err);
  }
}

export interface ReconciliationSummary {
  startedAt: string;
  finishedAt: string | null;
  matchesCreated: number | null;
  error: string | null;
}

export interface V4OperationalStatus {
  activeFsMonitors: number;
  activeWtbMonitors: number;
  chatOriginatedActiveFs: number;
  chatOriginatedActiveWtb: number;
  activeMatches: number;
  notificationsSent: number;
  notificationsFailed: number;
  lastNotificationError: string | null;
  lastNotificationErrorAt: string | null;
  lastReconciliation: ReconciliationSummary | null;
}

/**
 * Spec §14's admin operational-visibility requirements, all queried live against real DB state
 * (never a stale cached counter) — same "trust the database, not a mirror of it" convention
 * getSyncStatus already uses for inventory_listings. "Active" for a monitor means status='active'
 * AND expires_at > now(), matching the same eligibility rule matching.ts itself enforces.
 * "Active matches" means both sides of the pair are still active monitors right now — a match
 * discovered weeks ago whose postings have since expired/closed isn't a live match anymore.
 */
export async function getV4OperationalStatus(): Promise<V4OperationalStatus> {
  return withSchema(async (pool) => {
    const [postingCounts, activeMatches, notifications, meta, lastRun] = await Promise.all([
      pool.query(
        `SELECT type, source_type, COUNT(*)::int AS count
         FROM postings
         WHERE status = 'active' AND expires_at > now()
         GROUP BY type, source_type`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM matches m
         JOIN postings fs ON fs.id = m.fs_posting_id
         JOIN postings wtb ON wtb.id = m.wtb_posting_id
         WHERE fs.status = 'active' AND fs.expires_at > now()
           AND wtb.status = 'active' AND wtb.expires_at > now()`
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM match_recipients WHERE notified_at IS NOT NULL`),
      pool.query(`SELECT notifications_failed_count, last_notification_error, last_notification_error_at FROM postings_meta WHERE id = 1`),
      pool.query(
        `SELECT started_at, finished_at, matches_created, error FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1`
      ),
    ]);

    let activeFsMonitors = 0;
    let activeWtbMonitors = 0;
    let chatOriginatedActiveFs = 0;
    let chatOriginatedActiveWtb = 0;
    for (const row of postingCounts.rows) {
      if (row.type === "FS") {
        activeFsMonitors += row.count;
        if (row.source_type === "chat") chatOriginatedActiveFs += row.count;
      } else {
        activeWtbMonitors += row.count;
        if (row.source_type === "chat") chatOriginatedActiveWtb += row.count;
      }
    }

    const metaRow = meta.rows[0];
    const lastRunRow = lastRun.rows[0];

    return {
      activeFsMonitors,
      activeWtbMonitors,
      chatOriginatedActiveFs,
      chatOriginatedActiveWtb,
      activeMatches: activeMatches.rows[0]?.count ?? 0,
      notificationsSent: notifications.rows[0]?.count ?? 0,
      notificationsFailed: metaRow?.notifications_failed_count ?? 0,
      lastNotificationError: metaRow?.last_notification_error ?? null,
      lastNotificationErrorAt: metaRow?.last_notification_error_at ?? null,
      lastReconciliation: lastRunRow
        ? {
            startedAt: lastRunRow.started_at,
            finishedAt: lastRunRow.finished_at,
            matchesCreated: lastRunRow.matches_created,
            error: lastRunRow.error,
          }
        : null,
    };
  });
}
