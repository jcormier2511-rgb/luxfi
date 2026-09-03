import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("../admin/store") as typeof import("../admin/store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const groupActivity = require("./groupActivity") as typeof import("./groupActivity");

const { ingestChatPosting } = store;
const { getActiveGroupCount, getActiveGroupCountForContact } = groupActivity;

after(async () => {
  await db._closePoolForTests();
});

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await adminStore.initAdminSchema();
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
}

async function addGroup(chatId: string, name: string, status = "active"): Promise<void> {
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled,platform)
       VALUES($1,$2,$3,true,'whatsapp')`,
      [name, chatId, status]
    )
  );
}

test("a canonical user with no postings at all has an active-group count of 0", async () => {
  await resetAll();
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m1", senderIdentity: "lonely-poster", text: "FS Rolex REF1 $1000" });
  // Delete the posting so canonical user exists with zero postings, isolating this case.
  await db.withSchema((pool) => pool.query("DELETE FROM postings WHERE id=$1", [wtb.posting!.id]));
  assert.equal(await getActiveGroupCount(wtb.posting!.canonical_user_id!), 0);
});

test("counts a group only once even with multiple posts, and only when the group is approved+active", async () => {
  await resetAll();
  await addGroup("g1", "Miami Watch Traders");
  const first = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m1", senderIdentity: "poster-1", text: "FS Rolex REF1 $1000" });
  await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m2", senderIdentity: "poster-1", text: "WTB Omega REF2 budget $2000" });
  const canonicalUserId = first.posting!.canonical_user_id!;
  assert.equal(await getActiveGroupCount(canonicalUserId), 1, "two posts in the same approved group count as one active group, not two");
});

test("posting in a second approved+active group raises the count", async () => {
  await resetAll();
  await addGroup("g1", "Miami Watch Traders");
  await addGroup("g2", "NYC Dealers");
  const first = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m1", senderIdentity: "poster-2", text: "FS Rolex REF1 $1000" });
  await ingestChatPosting({ platform: "whatsapp", chatId: "g2", messageId: "m2", senderIdentity: "poster-2", text: "WTB Omega REF2 budget $2000" });
  const canonicalUserId = first.posting!.canonical_user_id!;
  assert.equal(await getActiveGroupCount(canonicalUserId), 2);
});

test("a group that is not (or no longer) approved+active is excluded from the count", async () => {
  await resetAll();
  await addGroup("g1", "Miami Watch Traders", "inactive");
  const first = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m1", senderIdentity: "poster-3", text: "FS Rolex REF1 $1000" });
  assert.equal(await getActiveGroupCount(first.posting!.canonical_user_id!), 0, "an inactive group must not count toward this signal");
});

test("a direct (non-chat) posting never counts toward group activity", async () => {
  await resetAll();
  await addGroup("g1", "Miami Watch Traders");
  const canonicalUserId = await db.withSchema(async (pool) => (await pool.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id);
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,canonical_user_id,type,original_text,brand,expires_at)
       VALUES('whatsapp','direct','g1',$1,'FS','FS Rolex REF1 $1000','Rolex',now()+interval '15 days')`,
      [canonicalUserId]
    )
  );
  assert.equal(await getActiveGroupCount(canonicalUserId), 0, "a direct posting must not be mistaken for group activity even if it happens to share a chat id");
});

test("getActiveGroupCountForContact resolves the same count by phone -- for v3 search-flow cards, which have no canonical_user_id of their own", async () => {
  await resetAll();
  await addGroup("g1", "Miami Watch Traders");
  await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "m1", senderIdentity: "poster-contact-1", text: "FS Rolex REF1 $1000" });
  assert.equal(await getActiveGroupCountForContact("poster-contact-1"), 1);
});

test("getActiveGroupCountForContact returns 0, not an error, for a phone with no linked identity at all", async () => {
  await resetAll();
  assert.equal(await getActiveGroupCountForContact("never-seen-before"), 0);
});
