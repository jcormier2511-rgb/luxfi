import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.GREEN_API_INSTANCE_ID = "1234567890";
process.env.GREEN_API_API_TOKEN = "test-green-api-token";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("./store") as typeof import("./store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const greenApiClient = require("../channels/greenApi") as typeof import("../channels/greenApi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncGroupsFromGreenApi } = require("./groupSync") as typeof import("./groupSync");

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

// Same one-mock-per-test pattern as groupSync.test.ts's mockDiscovered -- a test that changes
// what's "discovered" across several sync calls sets .current on a shared holder instead of
// re-mocking t.mock.method a second time.
function mockDiscovered(t: import("node:test").TestContext, groups: { groupId: string; name: string }[]) {
  const holder = { current: groups };
  t.mock.method(greenApiClient, "listGreenApiGroups", async () => holder.current.map((g) => ({ ...g, raw: {} })));
  return (next: { groupId: string; name: string }[]) => {
    holder.current = next;
  };
}

test("required: Green API discovery creates a KNOWN, accessible group without enabling monitoring or push -- same contract as the Whapi sync", async (t) => {
  mockDiscovered(t, [{ groupId: "ga-discover-1", name: "Green API Group" }]);
  const result = await syncGroupsFromGreenApi("green-acct-1");
  assert.equal(result.discovered, 1);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);

  const rows = await adminStore.listGroups();
  const row = rows.find((r: any) => r.group_id === "ga-discover-1");
  assert.ok(row, "the discovered group is now KNOWN");
  assert.equal(row.platform, "whatsapp");
  assert.equal(row.group_name, "Green API Group");
  assert.equal(row.source_account, "green-acct-1");
  assert.equal(row.accessible, true);
  assert.equal(row.monitoring_enabled, false, "discovery never auto-enables monitoring");
  assert.equal(row.push_enabled, false, "discovery never auto-enables push");
});

test("required: defaults sourceAccount to config.channels.greenApi.accountLabel when not given explicitly", async (t) => {
  mockDiscovered(t, [{ groupId: "ga-default-account", name: "Default Account Group" }]);
  await syncGroupsFromGreenApi();
  const row = (await adminStore.listGroups()).find((r: any) => r.group_id === "ga-default-account");
  assert.equal(row.source_account, "green-api", "config.ts's default GREEN_API_ACCOUNT_LABEL");
});

test("required regression: a group already known via Whapi (or manually added) that Green API also discovers merges into the SAME row, never a duplicate", async (t) => {
  const manual = await adminStore.saveGroup(actor, { group_name: "Manually Added", group_id: "ga-merge-1", platform: "whatsapp", monitoring_enabled: true });
  mockDiscovered(t, [{ groupId: "ga-merge-1", name: "Green API's Name For It" }]);
  await syncGroupsFromGreenApi("green-acct-1");

  const rows = await adminStore.listGroups();
  const matching = rows.filter((r: any) => r.group_id === "ga-merge-1" && r.platform === "whatsapp");
  assert.equal(matching.length, 1, "must not create a duplicate row");
  assert.equal(matching[0].id, manual.id);
  assert.equal(matching[0].monitoring_enabled, true, "the manually-set monitoring flag is untouched by discovery");
  assert.equal(matching[0].accessible, true);
});

test("required: a group that disappears from a later Green API sync is marked inaccessible, never deleted -- and reappearing marks it accessible again", async (t) => {
  const setDiscovered = mockDiscovered(t, [{ groupId: "ga-stay-1", name: "Stays" }, { groupId: "ga-disappear-1", name: "Disappears" }]);
  await syncGroupsFromGreenApi("green-acct-1");

  setDiscovered([{ groupId: "ga-stay-1", name: "Stays" }]);
  const result = await syncGroupsFromGreenApi("green-acct-1");
  assert.equal(result.markedInaccessible, 1);

  const rows = await adminStore.listGroups();
  const disappeared = rows.find((r: any) => r.group_id === "ga-disappear-1");
  assert.ok(disappeared, "the row must still exist -- never deleted");
  assert.equal(disappeared.accessible, false);

  setDiscovered([{ groupId: "ga-stay-1", name: "Stays" }, { groupId: "ga-disappear-1", name: "Disappears" }]);
  await syncGroupsFromGreenApi("green-acct-1");
  const reappeared = (await adminStore.listGroups()).find((r: any) => r.group_id === "ga-disappear-1");
  assert.equal(reappeared.accessible, true);
});

test("required: a group reachable through BOTH Whapi and Green API tracks each account's own accessibility separately, and stays accessible overall until neither reports it", async (t) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
  t.mock.method(whapiClient, "listWhapiGroups", async () => [{ groupId: "ga-shared-1", name: "Shared Group", raw: {} }]);
  mockDiscovered(t, [{ groupId: "ga-shared-1", name: "Shared Group" }]);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { syncGroupsFromWhapi } = require("./groupSync") as typeof import("./groupSync");
  await syncGroupsFromWhapi("whapi-acct");
  await syncGroupsFromGreenApi("green-acct-1");

  const rows = await adminStore.listGroups();
  const matching = rows.filter((r: any) => r.group_id === "ga-shared-1");
  assert.equal(matching.length, 1, "one logical group, not two, despite two different providers reporting it");
  assert.equal(matching[0].accessible, true);

  const access = await db.withSchema((pool) => pool.query("SELECT source_account FROM group_account_access WHERE approved_group_id=$1 ORDER BY source_account", [matching[0].id]));
  assert.deepEqual(access.rows.map((r: any) => r.source_account), ["green-acct-1", "whapi-acct"]);
});
