import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const registry = require("./groupRegistry") as typeof import("./groupRegistry");
const {
  enableGroup,
  disableGroup,
  setReferenceRequestsEnabled,
  isGroupDesignated,
  canMonitorListings,
  canUsePrivateConcierge,
  canRequestReferences,
  getDesignatedGroup,
  listDesignatedGroups,
} = registry;

after(() => db._closePoolForTests());

test("a group not in the registry at all is not designated and has no permissions", async () => {
  await db._resetDbForTests();
  assert.equal(await isGroupDesignated("unknown-group"), false);
  assert.equal(await canMonitorListings("unknown-group"), false);
  assert.equal(await canUsePrivateConcierge("unknown-group"), false);
  assert.equal(await canRequestReferences("unknown-group"), false);
  assert.equal(await getDesignatedGroup("unknown-group"), null);
});

test("enableGroup creates an active group with monitoring/concierge on by default and reference requests off", async () => {
  await db._resetDbForTests();
  const group = await enableGroup("g1", "WatchFacts Dealers");
  assert.equal(group.isActive, true);
  assert.equal(group.groupName, "WatchFacts Dealers");
  assert.equal(group.allowListingMonitoring, true);
  assert.equal(group.allowPrivateConcierge, true);
  assert.equal(group.allowReferenceRequests, false, "reference requests require a separate explicit opt-in");

  assert.equal(await isGroupDesignated("g1"), true);
  assert.equal(await canMonitorListings("g1"), true);
  assert.equal(await canUsePrivateConcierge("g1"), true);
  assert.equal(await canRequestReferences("g1"), false);
});

test("required regression: disableGroup revokes all permissions immediately without deleting the row", async () => {
  await db._resetDbForTests();
  await enableGroup("g1", "WatchFacts Dealers");
  await setReferenceRequestsEnabled("g1", true);
  await disableGroup("g1");

  assert.equal(await isGroupDesignated("g1"), false);
  assert.equal(await canMonitorListings("g1"), false, "monitoring permission alone must not survive a disabled group");
  assert.equal(await canRequestReferences("g1"), false, "reference-request permission alone must not survive a disabled group");

  const stored = await getDesignatedGroup("g1");
  assert.ok(stored, "the row itself is preserved, not deleted");
  assert.equal(stored!.isActive, false);
  assert.equal(stored!.allowReferenceRequests, true, "permission toggles are preserved for when the group is re-enabled");
});

test("re-enabling a previously disabled group restores access without resetting its other toggles", async () => {
  await db._resetDbForTests();
  await enableGroup("g1", "WatchFacts Dealers");
  await setReferenceRequestsEnabled("g1", true);
  await disableGroup("g1");
  await enableGroup("g1");

  assert.equal(await isGroupDesignated("g1"), true);
  assert.equal(await canRequestReferences("g1"), true, "the earlier reference-request opt-in must not be lost on re-enable");
});

test("required regression: reference requests require their own explicit opt-in, separate from general designation", async () => {
  await db._resetDbForTests();
  await enableGroup("g1");
  assert.equal(await isGroupDesignated("g1"), true);
  assert.equal(await canRequestReferences("g1"), false);

  await setReferenceRequestsEnabled("g1", true);
  assert.equal(await canRequestReferences("g1"), true);

  await setReferenceRequestsEnabled("g1", false);
  assert.equal(await canRequestReferences("g1"), false, "must be revocable independently of the group's overall active status");
});

test("listDesignatedGroups returns every group regardless of active status", async () => {
  await db._resetDbForTests();
  await enableGroup("g1", "Active Group");
  await enableGroup("g2", "Will Be Disabled");
  await disableGroup("g2");

  const groups = await listDesignatedGroups();
  assert.equal(groups.length, 2);
  const g2 = groups.find((g) => g.chatId === "g2");
  assert.equal(g2?.isActive, false, "a disabled group still appears in the full listing, not hidden");
});

test("enableGroup on an already-active group updates the name without duplicating the row", async () => {
  await db._resetDbForTests();
  await enableGroup("g1", "Original Name");
  await enableGroup("g1", "Updated Name");
  const groups = await listDesignatedGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].groupName, "Updated Name");
});

test("enableGroup called again without a name keeps the previously set name", async () => {
  await db._resetDbForTests();
  await enableGroup("g1", "Original Name");
  await enableGroup("g1"); // e.g. re-enabling after a disable, no name passed
  const group = await getDesignatedGroup("g1");
  assert.equal(group!.groupName, "Original Name");
});
