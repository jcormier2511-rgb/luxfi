import { Pool, PoolClient } from 'pg';
import { Platform } from '../types/domain';

export interface CanonicalUserIdentity {
  canonicalUserId: string;
  isProvisional: boolean;
}

/**
 * Resolves the canonical user for a platform identity, creating a provisional
 * canonical account + platform identity row if this is the first time we've
 * seen this platform user (spec section 5.2). Trial usage and billing always
 * hang off canonical_users, never off the platform identity.
 */
export async function resolveCanonicalUserForPlatformIdentity(
  db: Pool | PoolClient,
  params: { platform: Platform; platformUserId: string; chatId?: string; displayName?: string }
): Promise<CanonicalUserIdentity> {
  const existing = await db.query<{ canonical_user_id: string; is_provisional: boolean }>(
    `SELECT pi.canonical_user_id, cu.is_provisional
     FROM platform_identities pi
     JOIN canonical_users cu ON cu.id = pi.canonical_user_id
     WHERE pi.platform = $1 AND pi.platform_user_id = $2`,
    [params.platform, params.platformUserId]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const canonicalUserId = await resolveMergeTarget(db, row.canonical_user_id);
    return { canonicalUserId, isProvisional: row.is_provisional };
  }

  const userInsert = await db.query<{ id: string }>(
    `INSERT INTO canonical_users (display_name, is_provisional)
     VALUES ($1, true)
     RETURNING id`,
    [params.displayName ?? null]
  );
  const canonicalUserId = userInsert.rows[0].id;

  await db.query(
    `INSERT INTO platform_identities (canonical_user_id, platform, platform_user_id, chat_id, display_name, is_provisional)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (platform, platform_user_id) DO NOTHING`,
    [canonicalUserId, params.platform, params.platformUserId, params.chatId ?? null, params.displayName ?? null]
  );

  return { canonicalUserId, isProvisional: true };
}

export type AddPlatformIdentityResult =
  | { status: 'added' }
  | { status: 'already_linked' }
  | { status: 'conflict'; existingCanonicalUserId: string };

/**
 * Attaches a new platform identity to an existing canonical user -- e.g.
 * recording a member's email address so the email channel (which has no
 * inbound webhook of its own, see adapters/email.client.ts) has somewhere to
 * send to. Refuses to silently steal an identity that's already linked to a
 * different account; use mergeCanonicalUsers for that (spec 5.2), which
 * carries the history reassignment a plain identity move would skip.
 */
export async function addPlatformIdentityToCanonicalUser(
  pool: Pool,
  canonicalUserId: string,
  params: { platform: Platform; platformUserId: string; chatId?: string; displayName?: string }
): Promise<AddPlatformIdentityResult> {
  const existing = await pool.query<{ canonical_user_id: string }>(
    'SELECT canonical_user_id FROM platform_identities WHERE platform = $1 AND platform_user_id = $2',
    [params.platform, params.platformUserId]
  );
  if (existing.rows.length > 0) {
    const existingCanonicalUserId = existing.rows[0].canonical_user_id;
    if (existingCanonicalUserId === canonicalUserId) return { status: 'already_linked' };
    return { status: 'conflict', existingCanonicalUserId };
  }

  await pool.query(
    `INSERT INTO platform_identities (canonical_user_id, platform, platform_user_id, chat_id, display_name, is_provisional)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [canonicalUserId, params.platform, params.platformUserId, params.chatId ?? null, params.displayName ?? null]
  );
  return { status: 'added' };
}

/** Follows merged_into_id chain to the live canonical account. */
export async function resolveMergeTarget(db: Pool | PoolClient, canonicalUserId: string): Promise<string> {
  let currentId = canonicalUserId;
  for (let hops = 0; hops < 10; hops += 1) {
    const { rows } = await db.query<{ merged_into_id: string | null }>(
      'SELECT merged_into_id FROM canonical_users WHERE id = $1',
      [currentId]
    );
    if (rows.length === 0 || !rows[0].merged_into_id) return currentId;
    currentId = rows[0].merged_into_id;
  }
  return currentId;
}

/**
 * Merges `fromId` into `toId`: reassigns all identities and history, then
 * recomputes trial usage from the authoritative approvals ledger so a merge
 * can never create a second complimentary trial (spec section 5.2).
 */
export async function mergeCanonicalUsers(
  pool: Pool,
  fromId: string,
  toId: string
): Promise<void> {
  if (fromId === toId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM canonical_users WHERE id = $1 FOR UPDATE', [fromId]);
    await client.query('SELECT id FROM canonical_users WHERE id = $1 FOR UPDATE', [toId]);

    await client.query(
      'UPDATE platform_identities SET canonical_user_id = $2 WHERE canonical_user_id = $1',
      [fromId, toId]
    );
    await client.query('UPDATE postings SET canonical_user_id = $2 WHERE canonical_user_id = $1', [fromId, toId]);
    await client.query(
      'UPDATE billing_ledger SET canonical_user_id = $2 WHERE canonical_user_id = $1',
      [fromId, toId]
    );

    // Unique-per-(match, user[, revision]) tables: repoint, but drop the losing
    // duplicate on conflict so the merge itself stays idempotent and constraint-safe.
    await reassignDropOnConflict(client, 'match_recipients', 'recipient_canonical_user_id', fromId, toId);
    await reassignDropOnConflict(client, 'notifications', 'recipient_canonical_user_id', fromId, toId);
    await reassignDropOnConflict(client, 'approvals', 'approving_canonical_user_id', fromId, toId);
    await reassignDropOnConflict(client, 'passes', 'recipient_canonical_user_id', fromId, toId);
    await reassignDropOnConflict(client, 'counterparty_confirmations', 'counterparty_canonical_user_id', fromId, toId);

    await client.query(
      'UPDATE introductions SET fs_party_canonical_user_id = $2 WHERE fs_party_canonical_user_id = $1',
      [fromId, toId]
    );
    await client.query(
      'UPDATE introductions SET wtb_party_canonical_user_id = $2 WHERE wtb_party_canonical_user_id = $1',
      [fromId, toId]
    );

    // membership_entitlements is unique per user; keep the target's row if it has one,
    // otherwise adopt the source's.
    await client.query(
      `UPDATE membership_entitlements SET canonical_user_id = $2
       WHERE canonical_user_id = $1
         AND NOT EXISTS (SELECT 1 FROM membership_entitlements WHERE canonical_user_id = $2)`,
      [fromId, toId]
    );
    await client.query('DELETE FROM membership_entitlements WHERE canonical_user_id = $1', [fromId]);

    // Recompute trial usage from the authoritative approvals table -- never additive,
    // so linking accounts can never manufacture a second complimentary trial.
    await client.query(
      `UPDATE canonical_users SET trial_approvals_used = (
         SELECT COUNT(*) FROM approvals WHERE approving_canonical_user_id = $1 AND is_complimentary = true
       ), updated_at = now()
       WHERE id = $1`,
      [toId]
    );

    await client.query(
      'UPDATE canonical_users SET merged_into_id = $2, updated_at = now() WHERE id = $1',
      [fromId, toId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function reassignDropOnConflict(
  client: PoolClient,
  table: string,
  column: string,
  fromId: string,
  toId: string
): Promise<void> {
  await client.query(
    `UPDATE ${table} t SET ${column} = $2
     WHERE ${column} = $1
       AND NOT EXISTS (
         SELECT 1 FROM ${table} t2
         WHERE t2.${column} = $2 AND t2.match_id = t.match_id
           ${table === 'notifications' || table === 'match_recipients' ? 'AND t2.match_revision = t.match_revision' : ''}
       )`,
    [fromId, toId]
  );
  await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [fromId]);
}
