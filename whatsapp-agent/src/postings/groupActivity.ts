import { withSchema } from "./db";

/**
 * Groups (WhatsApp or Telegram) a canonical user is known to be active in -- "known" meaning
 * they've actually posted an FS/WTB listing there, not full membership: Fi has no participant
 * roster for any group, only a record of who has posted where (postings.source_chat_id).
 * Restricted to groups still approved_groups.status='active' today, so a group removed from
 * monitoring immediately stops counting toward this signal.
 */
export async function getActiveGroupCount(canonicalUserId: number): Promise<number> {
  return withSchema(async (pool) => {
    const result = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT ag.id)::int AS n
       FROM postings p
       JOIN approved_groups ag ON ag.whatsapp_chat_id = p.source_chat_id
       WHERE p.canonical_user_id = $1 AND p.source_type = 'chat' AND ag.status = 'active'`,
      [canonicalUserId]
    );
    return Number(result.rows[0]?.n ?? 0);
  });
}

/**
 * Same signal as getActiveGroupCount, but for the v3 on-demand search flow's FS/WTB cards
 * (matching/engine.ts's formatMatchCard), which are built from watchfacts/inventoryDb.ts's
 * separate `inventory_listings` table -- keyed by phone, with no canonical_user_id of its own.
 * Read-only: looks up an EXISTING linked identity rather than creating one (unlike
 * getOrCreateCanonicalUser), since this runs once per card shown to someone ELSE, not for the
 * searching user themselves -- it must never mint a canonical user just because their phone
 * number appeared in another person's search results. No existing identity simply means no
 * known activity yet, which is 0, not an error.
 */
export async function getActiveGroupCountForContact(phone: string): Promise<number> {
  const canonicalUserId = await withSchema(async (pool) => {
    const result = await pool.query<{ canonical_user_id: number }>(
      `SELECT canonical_user_id FROM linked_identities WHERE identity = $1 LIMIT 1`,
      [phone]
    );
    return result.rows[0]?.canonical_user_id ?? null;
  });
  if (canonicalUserId == null) return 0;
  return getActiveGroupCount(canonicalUserId);
}
