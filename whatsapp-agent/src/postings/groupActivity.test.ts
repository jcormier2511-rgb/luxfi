import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("../admin/store") as typeof import("../admin/store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestChatPosting } = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("./identity") as typeof import("./identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getActiveGroupCount, getActiveGroupCounts } = require("./groupActivity") as typeof import("./groupActivity");

after(async () => {
  // approved_groups is not part of the postings reset: leaving rows behind would switch every
  // later test file onto the database allowlist (see hasDatabaseGroupAllowlist).
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  await adminStore._closePoolForTests();
  await db._closePoolForTests();
});

async function reset(): Promise<void> {
  await db._resetDbForTests();
  await adminStore.initAdminSchema();
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
}

async function approveGroup(chatId: string, status: "active" | "inactive" = "active"): Promise<void> {
  await db.withSchema((pool) =>
    pool.query("INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled) VALUES($1,$2,$3,true)", [`Group ${chatId}`, chatId, status])
  );
}

let n = 0;
async function post(chatId: string, sender: string, text = "FS Rolex 126610LN $12,000"): Promise<void> {
  n += 1;
  const result = await ingestChatPosting({ platform: "whatsapp", chatId, messageId: `m-${n}`, senderIdentity: sender, text });
  assert.ok(result.posting, "fixture posting should classify");
}

test("a user with no postings is active in 0 groups", async () => {
  await reset();
  const userId = await getOrCreateCanonicalUser("whatsapp", "quiet-user");
  assert.equal(await getActiveGroupCount(userId), 0);
});

test("counts distinct active approved groups, not postings", async () => {
  await reset();
  await approveGroup("g-a");
  await approveGroup("g-b");
  await post("g-a", "dealer-1");
  await post("g-a", "dealer-1", "WTB Rolex 116500LN budget $30,000");
  await post("g-b", "dealer-1");
  const userId = await getOrCreateCanonicalUser("whatsapp", "dealer-1");
  assert.equal(await getActiveGroupCount(userId), 2, "two groups despite three postings");
});

test("inactive groups and chats Fi has not approved never count", async () => {
  await reset();
  await approveGroup("g-live");
  await approveGroup("g-paused", "inactive");
  await post("g-live", "dealer-2");
  await post("g-paused", "dealer-2");
  await post("g-unknown", "dealer-2");
  const userId = await getOrCreateCanonicalUser("whatsapp", "dealer-2");
  assert.equal(await getActiveGroupCount(userId), 1);
});

test("direct postings with no chat id contribute nothing", async () => {
  await reset();
  await approveGroup("g-live");
  const userId = await getOrCreateCanonicalUser("whatsapp", "direct-user");
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,canonical_user_id,source_identity,type,original_text,brand,reference,expires_at)
       VALUES('whatsapp','direct',NULL,$1,'direct-user','WTB','WTB Rolex 126610LN','rolex','126610LN',now()+interval '30 days')`,
      [userId]
    )
  );
  assert.equal(await getActiveGroupCount(userId), 0);
});

test("batched lookup keys by canonical user and omits users with nothing to count", async () => {
  await reset();
  await approveGroup("g-a");
  await post("g-a", "dealer-3");
  const active = await getOrCreateCanonicalUser("whatsapp", "dealer-3");
  const silent = await getOrCreateCanonicalUser("whatsapp", "dealer-4");
  const counts = await getActiveGroupCounts([active, silent, active]);
  assert.equal(counts.get(active), 1);
  assert.equal(counts.has(silent), false);
  assert.equal((await getActiveGroupCounts([])).size, 0);
});
