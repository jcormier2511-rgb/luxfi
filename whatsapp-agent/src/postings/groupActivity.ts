import { initAdminSchema } from "../admin/store";
import { withSchema } from "./db";

/**
 * "Groups active in" signal: how many distinct monitored dealer groups a canonical user has
 * posted into. A group counts only when Fi has it on file as an ACTIVE approved group — an
 * unapproved chat, a group switched to inactive, or a direct/API posting (no chat id) never
 * contributes, so the number is a statement about presence in Fi's own dealer network rather
 * than raw chat volume. Matched by chat id alone, exactly like isApprovedMonitoringGroup.
 */
const ACTIVE_GROUP_COUNT_SQL = `
  SELECT p.canonical_user_id, count(DISTINCT p.source_chat_id)::int AS n
  FROM postings p
  JOIN approved_groups g ON g.whatsapp_chat_id = p.source_chat_id AND g.status = 'active'
  WHERE p.canonical_user_id = ANY($1::int[])
    AND p.source_type = 'chat'
    AND p.source_chat_id IS NOT NULL
  GROUP BY p.canonical_user_id
`;

/** Batched variant for admin listings; users with no qualifying posting are simply absent. */
export async function getActiveGroupCounts(canonicalUserIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(canonicalUserIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return new Map();
  await initAdminSchema(); // approved_groups lives in the admin schema, not the postings one
  const result = await withSchema((pool) => pool.query<{ canonical_user_id: number; n: number }>(ACTIVE_GROUP_COUNT_SQL, [ids]));
  return new Map(result.rows.map((row) => [Number(row.canonical_user_id), Number(row.n)]));
}

export async function getActiveGroupCount(canonicalUserId: number): Promise<number> {
  return (await getActiveGroupCounts([canonicalUserId])).get(canonicalUserId) ?? 0;
}
