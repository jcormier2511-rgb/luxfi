import { Pool, PoolClient } from 'pg';
import { MATCHING_VERSION, Posting } from '../types/domain';
import { rowToPosting } from './posting.service';
import { createAndSendNotificationsForMatchRevision } from './notification.service';

export interface MatchConfig {
  /** Hard cap tolerance on top of a stated WTB max bid, as a percent (0 = strict cap). */
  priceTolerancePercent: number;
  /** Whether an FS/WTB pair without a WTB-specified reference number may still match. */
  allowBroadMatchWithoutReference: boolean;
}

export function getMatchConfig(): MatchConfig {
  return {
    priceTolerancePercent: Number(process.env.MATCH_PRICE_TOLERANCE_PERCENT ?? '0'),
    allowBroadMatchWithoutReference: (process.env.MATCH_ALLOW_BROAD_WITHOUT_REFERENCE ?? 'true') !== 'false',
  };
}

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/[\s-]+/g, '');
}

export interface MatchComputation {
  score: number;
  reasons: string[];
}

/**
 * Deterministic structured matching (spec section 7). `fs` is the item for sale,
 * `wtb` is the buyer's request -- wtb's specified attributes are the mandatory
 * criteria the fs listing must satisfy. Returns null when the pair does not
 * qualify as a potential match at all.
 */
export function computeMatch(fs: Posting, wtb: Posting, config: MatchConfig): MatchComputation | null {
  if (fs.postingType !== 'FS' || wtb.postingType !== 'WTB') return null;
  if (fs.canonicalUserId === wtb.canonicalUserId) return null;
  if (fs.status !== 'active' || fs.expiresAt.getTime() <= Date.now()) return null;
  if (wtb.status !== 'active' || wtb.expiresAt.getTime() <= Date.now()) return null;

  const reasons: string[] = [];
  let exactReference = false;

  const wtbRef = normalize(wtb.referenceNumber);
  if (wtbRef) {
    const fsRef = normalize(fs.referenceNumber);
    if (fsRef !== wtbRef) return null;
    exactReference = true;
    reasons.push('Exact reference number match');
  } else if (!config.allowBroadMatchWithoutReference) {
    return null;
  } else if (wtb.brand && fs.brand && normalize(wtb.brand) !== normalize(fs.brand)) {
    // When no reference is given, brand (when stated) is still a hard requirement.
    return null;
  }

  const attributeChecks: [string, string | null, string | null][] = [
    ['dial', wtb.dial, fs.dial],
    ['material', wtb.material, fs.material],
    ['condition', wtb.condition, fs.condition],
    ['box/papers', wtb.boxPapers, fs.boxPapers],
    ['location', wtb.location, fs.location],
    ['country', wtb.country, fs.country],
  ];
  let matchedAttributeCount = 0;
  for (const [label, wanted, actual] of attributeChecks) {
    if (!wanted) continue;
    if (normalize(wanted) !== normalize(actual)) return null;
    matchedAttributeCount += 1;
    reasons.push(`${label} matches`);
  }

  if (wtb.year != null) {
    if (fs.year == null || fs.year !== wtb.year) return null;
    matchedAttributeCount += 1;
    reasons.push('Year matches');
  }

  if (wtb.maxBid != null && fs.askingPrice != null) {
    const ceiling = wtb.maxBid * (1 + config.priceTolerancePercent / 100);
    if (fs.askingPrice > ceiling) return null;
    reasons.push('Asking price within stated maximum bid');
  }

  if (!exactReference && matchedAttributeCount === 0 && reasons.length === 0) {
    // No reference number and nothing else to go on beyond side/type/eligibility --
    // too weak to call a qualifying potential match.
    return null;
  }

  const score = exactReference
    ? 100
    : Math.min(95, 55 + matchedAttributeCount * 8 + (wtb.maxBid != null && fs.askingPrice != null ? 5 : 0));

  return { score, reasons };
}

async function loadActiveOppositeSide(
  client: PoolClient,
  posting: Posting
): Promise<Posting[]> {
  const oppositeType = posting.postingType === 'FS' ? 'WTB' : 'FS';
  const { rows } = await client.query(
    `SELECT * FROM postings WHERE posting_type = $1 AND status = 'active' AND expires_at > now()
       AND canonical_user_id != $2`,
    [oppositeType, posting.canonicalUserId]
  );
  return rows.map(rowToPosting);
}

interface UpsertMatchResult {
  matchId: string;
  revision: number;
  isNewOrBumpedRevision: boolean;
}

async function upsertMatch(
  client: PoolClient,
  fsId: string,
  wtbId: string,
  computation: MatchComputation,
  isMaterialChange: boolean
): Promise<UpsertMatchResult> {
  const existing = await client.query(
    'SELECT * FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2 FOR UPDATE',
    [fsId, wtbId]
  );

  if (existing.rows.length === 0) {
    const insert = await client.query(
      `INSERT INTO matches (fs_posting_id, wtb_posting_id, score, matching_version, reasons, revision, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'surfaced') RETURNING id, revision`,
      [fsId, wtbId, computation.score, MATCHING_VERSION, JSON.stringify(computation.reasons)]
    );
    return { matchId: insert.rows[0].id, revision: insert.rows[0].revision, isNewOrBumpedRevision: true };
  }

  const row = existing.rows[0];
  if (row.status === 'approved') {
    // Final state for MVP: an approved match is not re-litigated by later attribute
    // changes. Score/reasons are left as they were at approval time.
    return { matchId: row.id, revision: row.revision, isNewOrBumpedRevision: false };
  }

  const nextRevision = isMaterialChange ? row.revision + 1 : row.revision;
  const update = await client.query(
    `UPDATE matches SET score = $2, matching_version = $3, reasons = $4, revision = $5,
       status = CASE WHEN $5 != revision THEN 'surfaced' ELSE status END, updated_at = now()
     WHERE id = $1 RETURNING revision`,
    [row.id, computation.score, MATCHING_VERSION, JSON.stringify(computation.reasons), nextRevision]
  );
  return {
    matchId: row.id,
    revision: update.rows[0].revision,
    isNewOrBumpedRevision: isMaterialChange && nextRevision !== row.revision,
  };
}

async function ensureRecipients(client: PoolClient, matchId: string, revision: number, recipientIds: string[]) {
  for (const recipientId of recipientIds) {
    await client.query(
      `INSERT INTO match_recipients (match_id, recipient_canonical_user_id, match_revision)
       VALUES ($1, $2, $3)
       ON CONFLICT (match_id, recipient_canonical_user_id, match_revision) DO NOTHING`,
      [matchId, recipientId, revision]
    );
  }
}

/**
 * Runs matching for one posting against the current opposite-side inventory
 * (spec sections 4.1-4.3). Call with isMaterialChange=true when the posting was
 * just created or just materially updated; call with isMaterialChange=false from
 * the reconciliation job to safely recover missed pairings/notifications without
 * resurfacing anything that was already passed at its current revision.
 */
export async function runMatchingForPosting(
  pool: Pool,
  postingId: string,
  isMaterialChange: boolean
): Promise<{ matchCount: number }> {
  const config = getMatchConfig();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM postings WHERE id = $1', [postingId]);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { matchCount: 0 };
    }
    const posting = rowToPosting(rows[0]);
    if (posting.status !== 'active' || posting.expiresAt.getTime() <= Date.now()) {
      await client.query('COMMIT');
      return { matchCount: 0 };
    }

    const candidates = await loadActiveOppositeSide(client, posting);
    let matchCount = 0;
    const bumpedMatchIds: { matchId: string; revision: number }[] = [];

    for (const candidate of candidates) {
      const fs = posting.postingType === 'FS' ? posting : candidate;
      const wtb = posting.postingType === 'WTB' ? posting : candidate;
      const computation = computeMatch(fs, wtb, config);
      if (!computation) continue;

      const result = await upsertMatch(client, fs.id, wtb.id, computation, isMaterialChange);
      await ensureRecipients(client, result.matchId, result.revision, [fs.canonicalUserId, wtb.canonicalUserId]);
      matchCount += 1;
      // Notification creation is idempotent per (match, recipient, revision), so it's safe
      // to always attempt it here -- this is what lets reconciliation recover missed sends.
      bumpedMatchIds.push({ matchId: result.matchId, revision: result.revision });
    }

    await client.query('COMMIT');

    for (const m of bumpedMatchIds) {
      await createAndSendNotificationsForMatchRevision(pool, m.matchId, m.revision);
    }

    return { matchCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Recovers matches/notifications missed due to a webhook, API, or process
 * failure (spec section 4.3, acceptance test 16). Safe to run repeatedly:
 * matching and notification creation are both idempotent.
 */
export async function reconcileMatches(pool: Pool): Promise<{ postingsScanned: number }> {
  const { rows } = await pool.query(
    `SELECT id FROM postings WHERE status = 'active' AND expires_at > now()`
  );
  for (const row of rows) {
    await runMatchingForPosting(pool, row.id, false);
  }
  return { postingsScanned: rows.length };
}
