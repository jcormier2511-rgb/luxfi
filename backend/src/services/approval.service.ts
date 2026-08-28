import { Pool, PoolClient } from 'pg';
import { ACCOUNT_COMPLIMENTARY_APPROVAL_LIMIT, ContactMethod, MONITOR_APPROVED_MATCH_LIMIT } from '../types/domain';
import { checkApprovalGate, ensureEntitlement, PER_APPROVAL_PRICE_USD } from './entitlement.service';
import { sendConversionMessage } from './conversation.service';

export type ApproveOutcome =
  | { status: 'approved'; duplicate: boolean; isComplimentary: boolean }
  | { status: 'locked'; reason: 'locked_pending_admin_override' };

/**
 * Approve is atomic and idempotent, keyed by (match_id, approving_canonical_user_id)
 * -- spec sections 9.2 and 11.3. Repeated clicks return the original result and
 * never create a second approval, ledger entry, posting-count increment, or
 * trial-usage increment.
 */
export async function approveMatch(
  pool: Pool,
  matchId: string,
  approvingCanonicalUserId: string
): Promise<ApproveOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchRes = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('match not found');
    }
    const match = matchRes.rows[0];

    const existingApproval = await client.query(
      'SELECT * FROM approvals WHERE match_id = $1 AND approving_canonical_user_id = $2',
      [matchId, approvingCanonicalUserId]
    );
    if (existingApproval.rows.length > 0) {
      await client.query('COMMIT');
      return { status: 'approved', duplicate: true, isComplimentary: existingApproval.rows[0].is_complimentary };
    }

    const gate = await checkApprovalGate(client, approvingCanonicalUserId);
    if (!gate.allowed) {
      await client.query('COMMIT');
      return { status: 'locked', reason: gate.reason };
    }

    let ledgerEntryId: string | null = null;
    if (gate.isComplimentary) {
      const ledger = await client.query(
        `INSERT INTO billing_ledger (canonical_user_id, match_id, entry_type, amount, status)
         VALUES ($1, $2, 'complimentary_approval', 0, 'recorded') RETURNING id`,
        [approvingCanonicalUserId, matchId]
      );
      ledgerEntryId = ledger.rows[0].id;
    } else {
      // Never a live charge in this MVP -- payment processor is deferred (see payment.adapter.ts).
      const ledger = await client.query(
        `INSERT INTO billing_ledger (canonical_user_id, match_id, entry_type, amount, status)
         VALUES ($1, $2, 'paid_approval', $3, 'pending_billing') RETURNING id`,
        [approvingCanonicalUserId, matchId, PER_APPROVAL_PRICE_USD]
      );
      ledgerEntryId = ledger.rows[0].id;
    }

    await client.query(
      `INSERT INTO approvals (match_id, approving_canonical_user_id, is_complimentary, ledger_entry_id)
       VALUES ($1, $2, $3, $4)`,
      [matchId, approvingCanonicalUserId, gate.isComplimentary, ledgerEntryId]
    );

    let newTrialApprovalsUsed: number | null = null;
    if (gate.isComplimentary) {
      const updated = await client.query(
        `UPDATE canonical_users SET trial_approvals_used = trial_approvals_used + 1, updated_at = now()
         WHERE id = $1 RETURNING trial_approvals_used`,
        [approvingCanonicalUserId]
      );
      newTrialApprovalsUsed = updated.rows[0].trial_approvals_used;
    }

    // Increment the approving user's OWN posting's approved-match count (spec 6.1 / 9.2):
    // the posting-approved-match limit belongs to whichever side the approving user owns.
    await incrementPostingApprovedCount(client, match, approvingCanonicalUserId);

    await client.query(
      `UPDATE match_recipients SET decision = 'approved', decided_at = now()
       WHERE match_id = $1 AND recipient_canonical_user_id = $2 AND match_revision = $3`,
      [matchId, approvingCanonicalUserId, match.revision]
    );

    await syncMatchStatusAfterDecision(client, matchId);
    await syncIntroduction(client, matchId);

    await client.query('COMMIT');

    if (newTrialApprovalsUsed === ACCOUNT_COMPLIMENTARY_APPROVAL_LIMIT) {
      const entitlement = await ensureEntitlement(pool, approvingCanonicalUserId);
      await sendConversionMessage(pool, approvingCanonicalUserId, entitlement.watchFactsMemberVerified);
    }

    return { status: 'approved', duplicate: false, isComplimentary: gate.isComplimentary };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function incrementPostingApprovedCount(
  client: PoolClient,
  match: { id: string; fs_posting_id: string; wtb_posting_id: string },
  approvingCanonicalUserId: string
): Promise<void> {
  const fsOwner = await client.query('SELECT canonical_user_id FROM postings WHERE id = $1', [match.fs_posting_id]);
  const isFsOwner = fsOwner.rows[0]?.canonical_user_id === approvingCanonicalUserId;
  const ownedPostingId = isFsOwner ? match.fs_posting_id : match.wtb_posting_id;

  const updated = await client.query(
    `UPDATE postings SET approved_match_count = approved_match_count + 1, updated_at = now()
     WHERE id = $1
     RETURNING approved_match_count`,
    [ownedPostingId]
  );
  const newCount = updated.rows[0]?.approved_match_count ?? 0;
  if (newCount >= MONITOR_APPROVED_MATCH_LIMIT) {
    await client.query(
      `UPDATE postings SET status = 'completed_match_limit', updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [ownedPostingId]
    );
  }
}

async function syncMatchStatusAfterDecision(client: PoolClient, matchId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT decision FROM match_recipients WHERE match_id = $1
       AND match_revision = (SELECT revision FROM matches WHERE id = $1)`,
    [matchId]
  );
  const anyApproved = rows.some((r) => r.decision === 'approved');
  const allPassed = rows.length > 0 && rows.every((r) => r.decision === 'passed');
  if (anyApproved) {
    await client.query(`UPDATE matches SET status = 'approved', updated_at = now() WHERE id = $1`, [matchId]);
  } else if (allPassed) {
    await client.query(`UPDATE matches SET status = 'passed_all', updated_at = now() WHERE id = $1`, [matchId]);
  }
}

/**
 * Pass creates no charge and consumes no trial usage (spec 9.4). Idempotent:
 * repeated passes just leave the recipient's decision as 'passed'.
 */
export async function passMatch(pool: Pool, matchId: string, recipientCanonicalUserId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const matchRes = await client.query('SELECT revision FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
    if (matchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('match not found');
    }
    const revision = matchRes.rows[0].revision;

    await client.query(
      `INSERT INTO passes (match_id, recipient_canonical_user_id) VALUES ($1, $2)
       ON CONFLICT (match_id, recipient_canonical_user_id) DO NOTHING`,
      [matchId, recipientCanonicalUserId]
    );
    await client.query(
      `UPDATE match_recipients SET decision = 'passed', decided_at = now()
       WHERE match_id = $1 AND recipient_canonical_user_id = $2 AND match_revision = $3
         AND decision != 'approved'`,
      [matchId, recipientCanonicalUserId, revision]
    );

    await syncMatchStatusAfterDecision(client, matchId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function contactReleasable(contactMethods: ContactMethod[], confirmed: boolean): boolean {
  return contactMethods.some((m) => m.authorizedForSharing) || confirmed;
}

/**
 * Counterparty confirmation authorizes releasing that counterparty's contact
 * info once the other side has approved. It does not itself consume trial
 * usage or create a charge, and is not an approval of a separate task (spec 9.3).
 */
export async function confirmCounterparty(
  pool: Pool,
  matchId: string,
  counterpartyCanonicalUserId: string,
  confirmed: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO counterparty_confirmations (match_id, counterparty_canonical_user_id, confirmed, confirmed_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (match_id, counterparty_canonical_user_id)
     DO UPDATE SET confirmed = EXCLUDED.confirmed, confirmed_at = EXCLUDED.confirmed_at`,
    [matchId, counterpartyCanonicalUserId, confirmed]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await syncIntroduction(client, matchId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function syncIntroduction(client: PoolClient, matchId: string): Promise<void> {
  const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (matchRows.length === 0) return;
  const match = matchRows[0];

  const { rows: postingRows } = await client.query('SELECT * FROM postings WHERE id = ANY($1)', [
    [match.fs_posting_id, match.wtb_posting_id],
  ]);
  const fsPosting = postingRows.find((r) => r.id === match.fs_posting_id);
  const wtbPosting = postingRows.find((r) => r.id === match.wtb_posting_id);
  if (!fsPosting || !wtbPosting) return;

  const { rows: approvalRows } = await client.query('SELECT approving_canonical_user_id FROM approvals WHERE match_id = $1', [matchId]);
  const approvedUserIds = new Set(approvalRows.map((r) => r.approving_canonical_user_id));

  const { rows: confirmRows } = await client.query(
    'SELECT counterparty_canonical_user_id, confirmed FROM counterparty_confirmations WHERE match_id = $1',
    [matchId]
  );
  const confirmedFor = new Map(confirmRows.map((r) => [r.counterparty_canonical_user_id, r.confirmed]));

  const fsContactReleasable = contactReleasable(
    fsPosting.contact_methods ?? [],
    confirmedFor.get(fsPosting.canonical_user_id) ?? false
  );
  const wtbContactReleasable = contactReleasable(
    wtbPosting.contact_methods ?? [],
    confirmedFor.get(wtbPosting.canonical_user_id) ?? false
  );

  const wtbCanSeeFsContact = approvedUserIds.has(wtbPosting.canonical_user_id) && fsContactReleasable;
  const fsCanSeeWtbContact = approvedUserIds.has(fsPosting.canonical_user_id) && wtbContactReleasable;

  let status: 'pending' | 'contact_shared' | 'completed' = 'pending';
  if (wtbCanSeeFsContact && fsCanSeeWtbContact) status = 'completed';
  else if (wtbCanSeeFsContact || fsCanSeeWtbContact) status = 'contact_shared';

  await client.query(
    `INSERT INTO introductions (match_id, status, fs_party_canonical_user_id, wtb_party_canonical_user_id, contact_shared_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $2 != 'pending' THEN now() ELSE NULL END)
     ON CONFLICT (match_id) DO UPDATE SET
       status = EXCLUDED.status,
       contact_shared_at = COALESCE(introductions.contact_shared_at, EXCLUDED.contact_shared_at),
       updated_at = now()`,
    [matchId, status, fsPosting.canonical_user_id, wtbPosting.canonical_user_id]
  );
}

/**
 * Returns the counterparty's contact methods for `recipientCanonicalUserId`, or
 * null if disclosure is not yet authorized (recipient hasn't approved, or the
 * counterparty's contact isn't authorized/confirmed yet). This is the actual
 * gate for revealing protected contact information (spec 9.3, acceptance test 29);
 * introductions.status is a coarser audit summary, not the disclosure gate itself.
 */
export async function getRevealedContact(
  pool: Pool,
  matchId: string,
  recipientCanonicalUserId: string
): Promise<ContactMethod[] | null> {
  const { rows: matchRows } = await pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (matchRows.length === 0) return null;
  const match = matchRows[0];

  const { rows: postingRows } = await pool.query('SELECT * FROM postings WHERE id = ANY($1)', [
    [match.fs_posting_id, match.wtb_posting_id],
  ]);
  const fsPosting = postingRows.find((r) => r.id === match.fs_posting_id);
  const wtbPosting = postingRows.find((r) => r.id === match.wtb_posting_id);
  if (!fsPosting || !wtbPosting) return null;

  const recipientIsFsOwner = recipientCanonicalUserId === fsPosting.canonical_user_id;
  const recipientIsWtbOwner = recipientCanonicalUserId === wtbPosting.canonical_user_id;
  if (!recipientIsFsOwner && !recipientIsWtbOwner) return null;

  const approvalRes = await pool.query(
    'SELECT 1 FROM approvals WHERE match_id = $1 AND approving_canonical_user_id = $2',
    [matchId, recipientCanonicalUserId]
  );
  if (approvalRes.rows.length === 0) return null;

  const counterpartyPosting = recipientIsFsOwner ? wtbPosting : fsPosting;
  const authorized = (counterpartyPosting.contact_methods ?? []).filter((m: ContactMethod) => m.authorizedForSharing);
  if (authorized.length > 0) return authorized;

  const confirmRes = await pool.query(
    'SELECT confirmed FROM counterparty_confirmations WHERE match_id = $1 AND counterparty_canonical_user_id = $2',
    [matchId, counterpartyPosting.canonical_user_id]
  );
  if (confirmRes.rows.length > 0 && confirmRes.rows[0].confirmed) {
    return counterpartyPosting.contact_methods ?? [];
  }
  return null;
}
