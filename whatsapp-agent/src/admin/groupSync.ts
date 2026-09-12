import { config } from "../config";
import { listWhapiGroups } from "../whapi/client";
import { listGreenApiGroups } from "../channels/greenApi";
import { upsertGroupFromWhapiDiscovery, markGroupsInaccessibleForAccount } from "./store";

export interface GroupSyncResult {
  discovered: number;
  created: number;
  updated: number;
  markedInaccessible: number;
}

/**
 * Shared by every provider-specific sync below: imports/updates whatever `discover` currently
 * reports into the unified Group Registry -- NEVER enabling monitoring or push on its own, and
 * NEVER deleting a group that's since disappeared (see markGroupsInaccessibleForAccount).
 * CSV/manual additions and every discovery source below feed the SAME canonical table
 * (admin/store.ts's approved_groups), keyed by (platform, group_id) with each source account's
 * own reachability tracked separately in group_account_access.
 */
async function syncGroupsFromDiscovery(
  discover: () => Promise<{ groupId: string; name: string }[]>,
  sourceAccount: string
): Promise<GroupSyncResult> {
  const discovered = await discover();
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

/**
 * Whapi-driven group discovery (real reported requirement): queries the configured Whapi
 * channel for every group the connected account can currently see and imports/updates them
 * into the unified Group Registry.
 */
export async function syncGroupsFromWhapi(sourceAccount: string = config.whapi.accountLabel): Promise<GroupSyncResult> {
  return syncGroupsFromDiscovery(listWhapiGroups, sourceAccount);
}

/**
 * Green API's own group-discovery sync -- the counterpart to syncGroupsFromWhapi above. Real
 * reported gap: the Group Registry (approved_groups, what a "groups monitored" count actually
 * reflects) was populated EXCLUSIVELY from Whapi's discovery -- a separate WhatsApp connection
 * from the Green API numbers actually doing live sends and group monitoring today -- so a group
 * only a Green API-connected number belonged to could never appear here, and would silently
 * never be monitored even once its messages started arriving over that number's webhook.
 *
 * Only ever covers the ONE Green API instance Fi holds instanceId/apiToken for (config.channels.
 * greenApi -- the "push" number). An additional monitoring-only number (see channels/greenApi.ts's
 * own comment: Fi holds no credentials for those at all, by design) can never be actively
 * discovered this way -- only passively, from an actual incoming webhook message naming a
 * groupId Fi doesn't already know.
 */
export async function syncGroupsFromGreenApi(sourceAccount: string = config.channels.greenApi.accountLabel): Promise<GroupSyncResult> {
  return syncGroupsFromDiscovery(listGreenApiGroups, sourceAccount);
}
