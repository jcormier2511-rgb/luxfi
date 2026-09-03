import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("./store") as typeof import("./store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestChatPosting } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");

// audit() records a null actor as "anonymous" — no administrator row is needed for these checks.
const actor = null as unknown as import("./store").Administrator;

after(async () => {
  // approved_groups is not part of the postings reset: leaving rows behind would switch every
  // later test file onto the database allowlist (see hasDatabaseGroupAllowlist).
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups; DELETE FROM approved_users"));
  await adminStore._closePoolForTests();
  await db._closePoolForTests();
});

async function reset(): Promise<void> {
  await db._resetDbForTests();
  await adminStore.initAdminSchema();
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups; DELETE FROM approved_users"));
}

test("listUsers reports how many active monitored groups each approved user posts in", async () => {
  await reset();
  await db.withSchema((pool) =>
    pool.query("INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled) VALUES('A','grp-a','active',true),('B','grp-b','active',true),('C','grp-c','inactive',true)")
  );
  await adminStore.saveUser(actor, { phone: "13055550001", name: "Marco", access_status: "active" });
  await adminStore.saveUser(actor, { phone: "13055550002", name: "Silent", access_status: "active" });
  for (const [chatId, id] of [["grp-a", 1], ["grp-b", 2], ["grp-c", 3]] as const) {
    const result = await ingestChatPosting({ platform: "whatsapp", chatId, messageId: `m-${id}`, senderIdentity: "13055550001", text: "FS Rolex 126610LN $12,000" });
    assert.ok(result.posting);
  }

  const { rows } = await adminStore.listUsers();
  const byPhone = new Map(rows.map((r: any) => [r.phone, r]));
  assert.equal(byPhone.get("13055550001").active_groups_count, 2, "inactive group C is not counted");
  assert.equal(byPhone.get("13055550002").active_groups_count, 0, "a user Fi has never seen post shows 0, not undefined");
  assert.equal("active_groups_count" in rows[0], true, "column is present on every row so the Users table renders it");
});

test("the count is display-only and survives an edit round-trip untouched", async () => {
  await reset();
  const saved = await adminStore.saveUser(actor, { phone: "13055550003", name: "Editable", access_status: "active" });
  const listed = (await adminStore.listUsers()).rows.find((r: any) => r.phone === "13055550003");
  assert.equal(listed.active_groups_count, 0);
  // Posting the listed row (count included) back through saveUser must not fail or persist it.
  const updated = await adminStore.saveUser(actor, { ...listed, name: "Edited", active_groups_count: 99 }, Number(saved.id));
  assert.equal(updated.name, "Edited");
  assert.equal("active_groups_count" in updated, false, "never stored on approved_users");
  assert.equal((await adminStore.listUsers()).rows[0].active_groups_count, 0);
});
