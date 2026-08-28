import { Pool } from 'pg';
import { getMessagingAdapter } from '../adapters/messaging.adapter';

export interface VouchRequestResult {
  status: 'requested' | 'already_requested' | 'no_deal_found';
  vouchId?: string;
}

/**
 * Finds the most recent match this account actually approved -- a "deal"
 * needs both a match and this account's own approval on it, not just a
 * surfaced/passed match (spec 9.1's "Dealer reputation" concept only makes
 * sense for a completed transaction).
 */
export async function findMostRecentApprovedMatchForUser(pool: Pool, canonicalUserId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT match_id FROM approvals WHERE approving_canonical_user_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [canonicalUserId]
  );
  return rows[0]?.match_id ?? null;
}

/**
 * Requests a vouch from the counterparty of `matchId` on behalf of
 * `requestingCanonicalUserId` (spec 9.1: "Fi finds the relevant
 * conversation, confirms the transaction, and sends the request"). Idempotent
 * per (match, subject) -- repeated requests for the same deal don't re-spam
 * the counterparty.
 */
export async function requestVouch(
  pool: Pool,
  matchId: string,
  requestingCanonicalUserId: string
): Promise<VouchRequestResult> {
  const { rows: matchRows } = await pool.query('SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id = $1', [
    matchId,
  ]);
  if (matchRows.length === 0) return { status: 'no_deal_found' };

  const { rows: postingRows } = await pool.query('SELECT id, canonical_user_id FROM postings WHERE id = ANY($1)', [
    [matchRows[0].fs_posting_id, matchRows[0].wtb_posting_id],
  ]);
  const ownPosting = postingRows.find((r) => r.canonical_user_id === requestingCanonicalUserId);
  const counterpartyPosting = postingRows.find((r) => r.canonical_user_id !== requestingCanonicalUserId);
  if (!ownPosting || !counterpartyPosting) return { status: 'no_deal_found' };

  const inserted = await pool.query(
    `INSERT INTO dealer_vouches (match_id, subject_canonical_user_id, voucher_canonical_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (match_id, subject_canonical_user_id) DO NOTHING
     RETURNING id`,
    [matchId, requestingCanonicalUserId, counterpartyPosting.canonical_user_id]
  );
  if (inserted.rows.length === 0) return { status: 'already_requested' };

  const vouchId = inserted.rows[0].id;
  await getMessagingAdapter().send({
    recipientCanonicalUserId: counterpartyPosting.canonical_user_id,
    text: "Your counterparty from a recent deal asked for a review. Would you vouch for them?",
    buttons: [
      { label: 'Yes, vouch for them', action: `vouch-give:${vouchId}` },
      { label: 'No thanks', action: `vouch-decline:${vouchId}` },
    ],
  });
  return { status: 'requested', vouchId };
}

/** Records the counterparty's response and notifies the subject if it's positive. */
export async function respondToVouch(pool: Pool, vouchId: string, given: boolean, comment?: string): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE dealer_vouches SET status = $2, responded_at = now(), comment = COALESCE($3, comment)
     WHERE id = $1 AND status = 'requested'
     RETURNING subject_canonical_user_id`,
    [vouchId, given ? 'given' : 'declined', comment ?? null]
  );
  if (rows.length === 0 || !given) return;

  await getMessagingAdapter().send({
    recipientCanonicalUserId: rows[0].subject_canonical_user_id,
    text: "Good news -- you just received a positive review from a recent deal!",
  });
}

export interface VouchSummary {
  positiveVouchCount: number;
}

export async function getVouchSummary(pool: Pool, canonicalUserId: string): Promise<VouchSummary> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM dealer_vouches WHERE subject_canonical_user_id = $1 AND status = 'given'`,
    [canonicalUserId]
  );
  return { positiveVouchCount: rows[0].c };
}
