import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "test-whapi-token";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("./store") as typeof import("./store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncGroupsFromWhapi } = require("./groupSync") as typeof import("./groupSync");

const actor = null as unknown as import("./store").Administrator;

beforeEach(async () => {
  await adminStore.initAdminSchema();
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
});
after(async () => {
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  await adminStore._closePoolForTests();
  await db._closePoolForTests();
});

// t.mock.method can only wrap a given method once per test; a test that needs to change what's
// "discovered" across several sync calls sets .current on a shared holder instead of re-mocking.
function mockDiscovered(t: import("node:test").TestContext, groups: { groupId: string; name: string }[]) {
  const holder = { current: groups };
  t.mock.method(whapiClient, "listWhapiGroups", async () => holder.current.map((g) => ({ ...g, raw: {} })));
  return (next: { groupId: string; name: string }[]) => {
    holder.current = next;
  };
}

test("required: discovery creates a KNOWN, accessible group without enabling monitoring or push", async (t) => {
  mockDiscovered(t, [{ groupId: "wa-discover-1", name: "Discovered Group" }]);
  const result = await syncGroupsFromWhapi("acct-1");
  assert.equal(result.discovered, 1);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);

  const rows = await adminStore.listGroups();
  const row = rows.find((r: any) => r.group_id === "wa-discover-1");
  assert.ok(row, "the discovered group is now KNOWN");
  assert.equal(row.platform, "whatsapp");
  assert.equal(row.group_name, "Discovered Group");
  assert.equal(row.source_account, "acct-1");
  assert.equal(row.fi_is_member, true);
  assert.equal(row.accessible, true, "ACCESSIBLE");
  assert.equal(row.monitoring_enabled, false, "discovery never auto-enables monitoring");
  assert.equal(row.push_enabled, false, "discovery never auto-enables push");
});

test("required: re-syncing an already-known group preserves its manually-configured monitor/push settings", async (t) => {
  const setDiscovered = mockDiscovered(t, [{ groupId: "wa-preserve-1", name: "Original Name" }]);
  await syncGroupsFromWhapi("acct-1");
  const created = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-preserve-1");
  await adminStore.saveGroup(actor, { ...created, monitoring_enabled: true, push_enabled: true, priority: 7, category: "vip" }, Number(created.id));

  // A later sync re-discovers the SAME group, possibly under a renamed title.
  setDiscovered([{ groupId: "wa-preserve-1", name: "Renamed Group" }]);
  const result = await syncGroupsFromWhapi("acct-1");
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);

  const after1 = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-preserve-1");
  assert.equal(after1.group_name, "Renamed Group", "the name IS refreshed by discovery");
  assert.equal(after1.monitoring_enabled, true, "monitoring setting survives the resync");
  assert.equal(after1.push_enabled, true, "push setting survives the resync");
  assert.equal(after1.priority, 7);
  assert.equal(after1.category, "vip");
});

test("required regression: a manually-added group later discovered by Whapi merges into the SAME row, never a duplicate", async (t) => {
  const manual = await adminStore.saveGroup(actor, { group_name: "Manually Added", group_id: "wa-merge-1", platform: "whatsapp", monitoring_enabled: true });
  mockDiscovered(t, [{ groupId: "wa-merge-1", name: "Whapi's Name For It" }]);
  await syncGroupsFromWhapi("acct-1");

  const rows = await adminStore.listGroups();
  const matching = rows.filter((r: any) => r.group_id === "wa-merge-1" && r.platform === "whatsapp");
  assert.equal(matching.length, 1, "must not create a duplicate row");
  assert.equal(matching[0].id, manual.id);
  assert.equal(matching[0].monitoring_enabled, true, "the manually-set monitoring flag is untouched by discovery");
  assert.equal(matching[0].accessible, true);
});

test("required: a group that disappears from a later sync is marked inaccessible, never deleted", async (t) => {
  const setDiscovered = mockDiscovered(t, [{ groupId: "wa-stay-1", name: "Stays" }, { groupId: "wa-disappear-1", name: "Disappears" }]);
  await syncGroupsFromWhapi("acct-1");

  setDiscovered([{ groupId: "wa-stay-1", name: "Stays" }]);
  const result = await syncGroupsFromWhapi("acct-1");
  assert.equal(result.markedInaccessible, 1);

  const rows = await adminStore.listGroups();
  const stayed = rows.find((r: any) => r.group_id === "wa-stay-1");
  const disappeared = rows.find((r: any) => r.group_id === "wa-disappear-1");
  assert.ok(disappeared, "the row must still exist -- never deleted");
  assert.equal(disappeared.accessible, false);
  assert.equal(stayed.accessible, true);

  // Re-appearing in a later sync marks it accessible again.
  setDiscovered([{ groupId: "wa-stay-1", name: "Stays" }, { groupId: "wa-disappear-1", name: "Disappears" }]);
  await syncGroupsFromWhapi("acct-1");
  const reappeared = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-disappear-1");
  assert.equal(reappeared.accessible, true);
});

test("required: a group's monitor/push settings survive it going inaccessible and coming back", async (t) => {
  const setDiscovered = mockDiscovered(t, [{ groupId: "wa-settings-survive", name: "Group" }]);
  await syncGroupsFromWhapi("acct-1");
  const created = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-settings-survive");
  await adminStore.saveGroup(actor, { ...created, monitoring_enabled: true, push_enabled: true }, Number(created.id));

  setDiscovered([]); // this account no longer sees any groups
  await syncGroupsFromWhapi("acct-1");
  const inaccessible = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-settings-survive");
  assert.equal(inaccessible.accessible, false);
  assert.equal(inaccessible.monitoring_enabled, true, "settings must survive going inaccessible");
  assert.equal(inaccessible.push_enabled, true);
});

test("required: multiple accounts can each report accessibility for the same logical group without duplicating it", async (t) => {
  const setDiscovered = mockDiscovered(t, [{ groupId: "wa-shared-account-group", name: "Shared Group" }]);
  await syncGroupsFromWhapi("acct-A");
  await syncGroupsFromWhapi("acct-B");

  const rows = await adminStore.listGroups();
  const matching = rows.filter((r: any) => r.group_id === "wa-shared-account-group");
  assert.equal(matching.length, 1, "one logical group, not two, despite two accounts reporting it");
  assert.equal(matching[0].accessible, true);

  const access = await db.withSchema((pool) => pool.query("SELECT source_account, accessible FROM group_account_access WHERE approved_group_id=$1 ORDER BY source_account", [matching[0].id]));
  assert.equal(access.rows.length, 2, "each account's own accessibility is tracked separately");
  assert.deepEqual(access.rows.map((r: any) => r.source_account), ["acct-A", "acct-B"]);

  // Account A stops seeing the group -- since account B still does, the group must NOT read as inaccessible overall.
  setDiscovered([]);
  await syncGroupsFromWhapi("acct-A");
  const afterA = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-shared-account-group");
  assert.equal(afterA.accessible, true, "still accessible via account B");

  // Now account B also stops seeing it -- only now does the summary flag flip to inaccessible.
  await syncGroupsFromWhapi("acct-B");
  const afterBoth = (await adminStore.listGroups()).find((r: any) => r.group_id === "wa-shared-account-group");
  assert.equal(afterBoth.accessible, false, "inaccessible via every known account");
});

test("required: bulk actions apply only to the selected groups", async (t) => {
  const a = await adminStore.saveGroup(actor, { group_name: "A", group_id: "bulk-a", platform: "whatsapp" });
  const b = await adminStore.saveGroup(actor, { group_name: "B", group_id: "bulk-b", platform: "whatsapp" });
  const untouched = await adminStore.saveGroup(actor, { group_name: "C", group_id: "bulk-c", platform: "whatsapp" });

  await adminStore.bulkUpdateGroups(actor, [Number(a.id), Number(b.id)], "enable_monitoring");
  let rows = await adminStore.listGroups();
  assert.equal(rows.find((r: any) => r.id === a.id).monitoring_enabled, true);
  assert.equal(rows.find((r: any) => r.id === b.id).monitoring_enabled, true);
  assert.equal(rows.find((r: any) => r.id === untouched.id).monitoring_enabled, false, "an unselected group is never touched");

  await adminStore.bulkUpdateGroups(actor, [Number(a.id)], "enable_push_fs");
  rows = await adminStore.listGroups();
  const rowA = rows.find((r: any) => r.id === a.id);
  assert.equal(rowA.push_enabled, true);
  assert.equal(rowA.allow_fs, true);

  await adminStore.bulkUpdateGroups(actor, [Number(a.id), Number(b.id)], "set_priority", 5);
  rows = await adminStore.listGroups();
  assert.equal(rows.find((r: any) => r.id === a.id).priority, 5);
  assert.equal(rows.find((r: any) => r.id === b.id).priority, 5);

  await adminStore.bulkUpdateGroups(actor, [Number(b.id)], "set_category", "wholesale");
  rows = await adminStore.listGroups();
  assert.equal(rows.find((r: any) => r.id === b.id).category, "wholesale");
  assert.equal(rows.find((r: any) => r.id === a.id).category, null);

  await adminStore.bulkUpdateGroups(actor, [Number(a.id)], "disable_monitoring");
  await adminStore.bulkUpdateGroups(actor, [Number(a.id)], "disable_push");
  rows = await adminStore.listGroups();
  const finalA = rows.find((r: any) => r.id === a.id);
  assert.equal(finalA.monitoring_enabled, false);
  assert.equal(finalA.push_enabled, false);
});

test("required: bulk set_priority rejects a non-numeric value", async () => {
  const a = await adminStore.saveGroup(actor, { group_name: "A", group_id: "bulk-invalid", platform: "whatsapp" });
  await assert.rejects(() => adminStore.bulkUpdateGroups(actor, [Number(a.id)], "set_priority", "not-a-number"), /priority must be a number/);
});

test("required: reconciliation metrics count KNOWN, ACCESSIBLE, MONITORING, and PUSH as separate dimensions", async () => {
  await adminStore.saveGroup(actor, { group_name: "Monitor only", group_id: "metric-1", platform: "whatsapp", monitoring_enabled: true });
  await adminStore.saveGroup(actor, { group_name: "Push only", group_id: "metric-2", platform: "whatsapp", push_enabled: true });
  await adminStore.saveGroup(actor, { group_name: "Inaccessible", group_id: "metric-3", platform: "whatsapp", accessible: false });
  await adminStore.saveGroup(actor, { group_name: "Neither", group_id: "metric-4", platform: "whatsapp" });

  const metrics = await adminStore.getGroupRegistryMetrics();
  assert.equal(metrics.known, 4);
  assert.equal(metrics.accessibleViaWhapi, 3);
  assert.equal(metrics.monitoringEnabled, 1);
  assert.equal(metrics.pushEnabled, 1);
  assert.equal(metrics.missingOrInaccessible, 1);
});
