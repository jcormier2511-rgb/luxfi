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
