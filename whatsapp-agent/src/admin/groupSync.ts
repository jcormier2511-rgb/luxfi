import { config } from "../config";
import { listWhapiGroups } from "../whapi/client";
import { upsertGroupFromWhapiDiscovery, markGroupsInaccessibleForAccount } from "./store";

export interface GroupSyncResult {
  discovered: number;
  created: number;
  updated: number;
  markedInaccessible: number;
}

/**
 * Whapi-driven group discovery (real reported requirement): queries the configured Whapi
 * channel for every group the connected account can currently see and imports/updates them
 * into the unified Group Registry -- NEVER enabling monitoring or push on its own, and NEVER
 * deleting a group that's since disappeared (see markGroupsInaccessibleForAccount). CSV/manual
 * additions and this discovery feed the SAME canonical table (admin/store.ts's approved_groups).
 */
export async function syncGroupsFromWhapi(sourceAccount: string = config.whapi.accountLabel): Promise<GroupSyncResult> {
  const discovered = await listWhapiGroups();
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  for (const g of discovered) {
    const result = await upsertGroupFromWhapiDiscovery({
      groupId: g.groupId,
      groupName: g.name || g.groupId,
      platform: "whatsapp",
      sourceAccount,
      lastVerifiedAt: now,
    });
    if (result.created) created++;
    else updated++;
  }
  const markedInaccessible = await markGroupsInaccessibleForAccount(
    sourceAccount,
    discovered.map((g) => g.groupId)
  );
  return { discovered: discovered.length, created, updated, markedInaccessible };
}
