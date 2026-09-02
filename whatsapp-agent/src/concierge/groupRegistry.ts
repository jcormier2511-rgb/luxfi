import { withSchema } from "./db";

export interface DesignatedGroup {
  chatId: string;
  groupName: string;
  isActive: boolean;
  watchfactsAdminManaged: boolean;
  allowListingMonitoring: boolean;
  allowPrivateConcierge: boolean;
  allowReferenceRequests: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  chat_id: string;
  group_name: string;
  is_active: boolean;
  watchfacts_admin_managed: boolean;
  allow_listing_monitoring: boolean;
  allow_private_concierge: boolean;
  allow_reference_requests: boolean;
  created_at: string;
  updated_at: string;
}

function rowToGroup(row: GroupRow): DesignatedGroup {
  return {
    chatId: row.chat_id,
    groupName: row.group_name,
    isActive: row.is_active,
    watchfactsAdminManaged: row.watchfacts_admin_managed,
    allowListingMonitoring: row.allow_listing_monitoring,
    allowPrivateConcierge: row.allow_private_concierge,
    allowReferenceRequests: row.allow_reference_requests,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDesignatedGroup(chatId: string): Promise<DesignatedGroup | null> {
  return withSchema(async (pool) => {
    const result = await pool.query<GroupRow>(`SELECT * FROM designated_groups WHERE chat_id = $1`, [chatId]);
    return result.rows[0] ? rowToGroup(result.rows[0]) : null;
  });
}

export async function listDesignatedGroups(): Promise<DesignatedGroup[]> {
  return withSchema(async (pool) => {
    const result = await pool.query<GroupRow>(`SELECT * FROM designated_groups ORDER BY chat_id`);
    return result.rows.map(rowToGroup);
  });
}

/** Creates the group (all permissions defaulting per the schema) if it doesn't exist, or re-activates + renames it if it does. Never clears an existing group's permission toggles. */
export async function enableGroup(chatId: string, groupName?: string): Promise<DesignatedGroup> {
  return withSchema(async (pool) => {
    const result = await pool.query<GroupRow>(
      `INSERT INTO designated_groups (chat_id, group_name, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (chat_id) DO UPDATE SET
         is_active = TRUE,
         group_name = CASE WHEN excluded.group_name <> '' THEN excluded.group_name ELSE designated_groups.group_name END,
         updated_at = now()
       RETURNING *`,
      [chatId, groupName ?? ""]
    );
    return rowToGroup(result.rows[0]);
  });
}

/** Deactivates a group without deleting its row — its permission toggles are preserved in case it's re-enabled later. A group that was never designated at all is a no-op (no row created just to disable it). */
export async function disableGroup(chatId: string): Promise<void> {
  await withSchema((pool) => pool.query(`UPDATE designated_groups SET is_active = FALSE, updated_at = now() WHERE chat_id = $1`, [chatId]));
}

export async function setReferenceRequestsEnabled(chatId: string, enabled: boolean): Promise<void> {
  await withSchema((pool) =>
    pool.query(`UPDATE designated_groups SET allow_reference_requests = $1, updated_at = now() WHERE chat_id = $2`, [enabled, chatId])
  );
}

async function hasPermission(chatId: string, column: "allow_listing_monitoring" | "allow_private_concierge" | "allow_reference_requests"): Promise<boolean> {
  return withSchema(async (pool) => {
    const result = await pool.query<{ ok: boolean }>(
      `SELECT (is_active AND ${column}) AS ok FROM designated_groups WHERE chat_id = $1`,
      [chatId]
    );
    return result.rows[0]?.ok ?? false;
  });
}

/** True only for an active, admin-designated group — the baseline check every other permission below also requires via is_active. */
export async function isGroupDesignated(chatId: string): Promise<boolean> {
  return withSchema(async (pool) => {
    const result = await pool.query<{ is_active: boolean }>(`SELECT is_active FROM designated_groups WHERE chat_id = $1`, [chatId]);
    return result.rows[0]?.is_active ?? false;
  });
}

export async function canMonitorListings(chatId: string): Promise<boolean> {
  return hasPermission(chatId, "allow_listing_monitoring");
}

export async function canUsePrivateConcierge(chatId: string): Promise<boolean> {
  return hasPermission(chatId, "allow_private_concierge");
}

export async function canRequestReferences(chatId: string): Promise<boolean> {
  return hasPermission(chatId, "allow_reference_requests");
}
