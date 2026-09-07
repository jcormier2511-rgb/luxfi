import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("./store") as typeof import("./store");

// audit() records a null actor as "anonymous" -- no administrator row is needed for these checks.
const actor = null as unknown as import("./store").Administrator;

beforeEach(async () => {
  await adminStore.initAdminSchema();
  // approved_groups is not part of the postings reset -- see groupActivity.test.ts's own
  // comment on this; other test files' rows must never leak into these assertions.
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
});
after(async () => {
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  await adminStore._closePoolForTests();
  await db._closePoolForTests();
});

test("required: create defaults monitoring_enabled and push_enabled to false when not specified", async () => {
  const row = await adminStore.saveGroup(actor, { group_name: "Miami Dealers", group_id: "grp-defaults", platform: "whatsapp" });
  assert.equal(row.monitoring_enabled, false);
  assert.equal(row.push_enabled, false);
  // Monitor FS/WTB and push allow FS/WTB still default true -- only the master toggles default off.
  assert.equal(row.monitor_fs, true);
  assert.equal(row.monitor_wtb, true);
  assert.equal(row.allow_fs, true);
  assert.equal(row.allow_wtb, true);
  assert.equal(row.priority, 100);
  assert.equal(row.accessible, true);
  assert.equal(row.fi_is_member, null);
});

test("required: create accepts every unified manual field", async () => {
  const row = await adminStore.saveGroup(actor, {
    group_name: "Asia Buyers",
    group_id: "-1001234567890",
    platform: "telegram",
    source_account: "whapi-account-1",
    monitoring_enabled: true,
    push_enabled: true,
    allow_fs: false,
    allow_wtb: true,
    priority: 25,
    category: "luxury-watches",
    notes: "High volume group",
    fi_is_member: true,
    last_verified_at: new Date().toISOString(),
  });
  assert.equal(row.group_name, "Asia Buyers");
  assert.equal(row.platform, "telegram");
  assert.equal(row.source_account, "whapi-account-1");
  assert.equal(row.monitoring_enabled, true);
  assert.equal(row.push_enabled, true);
  assert.equal(row.allow_fs, false);
  assert.equal(row.allow_wtb, true);
  assert.equal(row.priority, 25);
  assert.equal(row.category, "luxury-watches");
  assert.equal(row.fi_is_member, true);
  assert.ok(row.last_verified_at);
});

test("required regression: entering an existing group ID (same platform) on Add loads/updates the existing record instead of creating a duplicate", async () => {
  const first = await adminStore.saveGroup(actor, { group_name: "Original Name", group_id: "grp-dup", platform: "whatsapp", monitoring_enabled: true });
  // A second "Add" (no id given) with the same platform+group_id must update the SAME row.
  const second = await adminStore.saveGroup(actor, { group_name: "Renamed", group_id: "grp-dup", platform: "whatsapp", monitoring_enabled: false, notes: "updated via re-add" });
  assert.equal(second.id, first.id, "must be the same row, not a new one");
  assert.equal(second.group_name, "Renamed");
  assert.equal(second.monitoring_enabled, false);

  const all = await adminStore.listGroups();
  assert.equal(all.filter((g: any) => g.group_id === "grp-dup" && g.platform === "whatsapp").length, 1, "no duplicate row for the same platform+group_id");
});

test("required: platform + group_id must be unique, not group_id alone -- the same group_id on two platforms is two distinct rows", async () => {
  const wa = await adminStore.saveGroup(actor, { group_name: "WA Group", group_id: "shared-id-1", platform: "whatsapp" });
  const tg = await adminStore.saveGroup(actor, { group_name: "TG Group", group_id: "shared-id-1", platform: "telegram" });
  assert.notEqual(wa.id, tg.id);
  const all = await adminStore.listGroups();
  assert.equal(all.filter((g: any) => g.group_id === "shared-id-1").length, 2);
});

test("required regression: editing an already-loaded row (id given) updates it in place, preserving created_at", async () => {
  const created = await adminStore.saveGroup(actor, { group_name: "Editable", group_id: "grp-edit", platform: "whatsapp" });
  await new Promise((r) => setTimeout(r, 10));
  const edited = await adminStore.saveGroup(actor, { group_name: "Edited Name", group_id: "grp-edit", platform: "whatsapp", monitoring_enabled: true }, Number(created.id));
  assert.equal(edited.id, created.id);
  assert.equal(edited.group_name, "Edited Name");
  assert.equal(edited.monitoring_enabled, true);
  assert.equal(new Date(edited.created_at).getTime(), new Date(created.created_at).getTime(), "created_at is an audit timestamp -- never rewritten by an edit");
  assert.notEqual(new Date(edited.updated_at).getTime(), new Date(created.created_at).getTime(), "updated_at DOES advance on an edit");
});

test("required: disabling then re-enabling a group preserves its other settings, exactly like the concierge registry's own contract", async () => {
  const created = await adminStore.saveGroup(actor, { group_name: "Toggle Group", group_id: "grp-toggle", platform: "whatsapp", monitoring_enabled: true, push_enabled: true, priority: 5, category: "vip" });
  const disabled = await adminStore.saveGroup(actor, { ...created, status: "inactive" }, Number(created.id));
  assert.equal(disabled.status, "inactive");
  assert.equal(await adminStore.isApprovedMonitoringGroup("grp-toggle"), false, "an inactive group is never a valid monitoring gate, even with monitoring_enabled still true");

  const reenabled = await adminStore.saveGroup(actor, { ...disabled, status: "active" }, Number(created.id));
  assert.equal(reenabled.status, "active");
  assert.equal(reenabled.monitoring_enabled, true, "monitoring toggle survives the disable/re-enable round trip");
  assert.equal(reenabled.push_enabled, true, "push toggle survives too");
  assert.equal(reenabled.priority, 5);
  assert.equal(reenabled.category, "vip");
  assert.equal(await adminStore.isApprovedMonitoringGroup("grp-toggle"), true);
});

test("required: validation rejects a missing group name, a missing group ID, and a wildcard group ID", async () => {
  await assert.rejects(() => adminStore.saveGroup(actor, { group_id: "grp-noname" }), /group name and a specific group ID are required/);
  await assert.rejects(() => adminStore.saveGroup(actor, { group_name: "No ID" }), /group name and a specific group ID are required/);
  await assert.rejects(() => adminStore.saveGroup(actor, { group_name: "Wildcard", group_id: "*" }), /group name and a specific group ID are required/);
});

test("required: editing a nonexistent id fails clearly rather than silently doing nothing", async () => {
  await assert.rejects(() => adminStore.saveGroup(actor, { group_name: "Ghost", group_id: "grp-ghost", platform: "whatsapp" }, 999999999), /group not found/);
});

test("required: delete is rejected without explicit confirmation, and succeeds once confirmed", async () => {
  const row = await adminStore.saveGroup(actor, { group_name: "Deletable", group_id: "grp-delete", platform: "whatsapp" });
  await assert.rejects(() => adminStore.deleteGroup(actor, Number(row.id), false), /explicit confirmation/);
  assert.ok((await adminStore.listGroups()).some((g: any) => g.id === row.id), "must still exist after a non-confirmed delete attempt");

  await adminStore.deleteGroup(actor, Number(row.id), true);
  assert.equal((await adminStore.listGroups()).some((g: any) => g.id === row.id), false);
});

test("required: default push_enabled/monitor_enabled = false means a freshly-added group never gates monitoring or push until explicitly turned on", async () => {
  await adminStore.saveGroup(actor, { group_name: "Fresh Group", group_id: "grp-fresh", platform: "whatsapp", status: "active" });
  assert.equal(await adminStore.isApprovedMonitoringGroup("grp-fresh"), false, "monitoring_enabled defaults false, so a fresh group is never a monitoring gate");
  const eligible = await adminStore.listActivePushEligibleGroups("FS");
  assert.equal(eligible.some((g) => g.group_id === "grp-fresh"), false, "push_enabled defaults false, so a fresh group is never push-eligible");
});

test("last push result and ingestion tracking are recorded onto the registry row", async () => {
  await adminStore.saveGroup(actor, { group_name: "Tracked", group_id: "grp-tracked", platform: "whatsapp" });
  await adminStore.recordGroupPushResult("grp-tracked", "posted");
  await adminStore.recordGroupIngestion("grp-tracked", true);
  const rows = await adminStore.listGroups("", "");
  const row = rows.find((g: any) => g.group_id === "grp-tracked");
  assert.equal(row.last_push_result, "posted");
  assert.ok(row.last_push_at);
  assert.ok(row.last_message_at);
  assert.ok(row.last_successful_ingest_at);
  assert.equal(row.ingestion_status, "ok");

  await adminStore.recordGroupIngestion("grp-tracked", false, "boom");
  const afterFailure = (await adminStore.listGroups()).find((g: any) => g.group_id === "grp-tracked");
  assert.equal(afterFailure.ingestion_status, "error");
  assert.equal(afterFailure.ingestion_error, "boom");
  assert.ok(afterFailure.last_message_at, "last_message_at still updates even on an ingestion failure");
});
