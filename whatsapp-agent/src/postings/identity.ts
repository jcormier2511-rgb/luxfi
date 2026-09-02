import { withSchema } from "./db";

/**
 * Fi Build Spec v4 §5.2: trial usage and billing belong to the canonical account, not a
 * phone number. For this MVP, every WhatsApp phone number gets its own canonical user
 * (auto-created on first contact) — there's no cross-platform identity-merge UI yet, so
 * phone and canonical_user are 1:1. Real merging (e.g. linking a second phone to the same
 * WatchFacts member) is future work; the schema (linked_identities) is ready for it.
 */
export async function getOrCreateCanonicalUser(platform: string, identity: string): Promise<number> {
  return withSchema(async (pool) => {
    const existing = await pool.query(`SELECT canonical_user_id FROM linked_identities WHERE platform = $1 AND identity = $2`, [
      platform,
      identity,
    ]);
    if (existing.rows.length > 0) return existing.rows[0].canonical_user_id as number;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query(`INSERT INTO canonical_users DEFAULT VALUES RETURNING id`);
      const canonicalUserId = userResult.rows[0].id as number;
      await client.query(`INSERT INTO linked_identities (canonical_user_id, platform, identity) VALUES ($1, $2, $3)`, [
        canonicalUserId,
        platform,
        identity,
      ]);
      await client.query("COMMIT");
      return canonicalUserId;
    } catch (err) {
      await client.query("ROLLBACK");
      // Lost a race with a concurrent insert for the same identity — read back the winner.
      const retry = await pool.query(`SELECT canonical_user_id FROM linked_identities WHERE platform = $1 AND identity = $2`, [
        platform,
        identity,
      ]);
      if (retry.rows.length > 0) return retry.rows[0].canonical_user_id as number;
      throw err;
    } finally {
      client.release();
    }
  });
}
