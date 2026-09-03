import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-market-digest-"));
process.env.PERSIST_DIR = persist;
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "test-token";
process.env.ENABLE_MARKET_UPDATES = "true";

const db = require("./postings/db") as typeof import("./postings/db");
const entitlementDb = require("./billing/entitlementStore") as typeof import("./billing/entitlementStore");
const store = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
const whapi = require("./whapi/client") as typeof import("./whapi/client");
const updates = require("./marketUpdates") as typeof import("./marketUpdates");

after(async () => {
  await db._closePoolForTests();
  await entitlementDb._closePoolForTests();
  fs.rmSync(persist, { recursive: true, force: true });
});

async function markPaid(...phones: string[]) {
  for (const phone of phones) {
    await entitlementDb.getEntitlement(phone);
    await db.withSchema((pool) => pool.query(`UPDATE account_entitlements SET plan='tier1', payment_authorized=true, payment_status='active' WHERE phone=$1`, [phone]));
  }
}

async function add(phone: string, messageId: string, text: string) {
  return store.ingestChatPosting({ platform: "whatsapp", chatId: "market", messageId, senderIdentity: phone, text });
}

test("combined delivery is billing-neutral, replica-idempotent, and retries Whapi failures", async (t) => {
  await db._resetDbForTests();
  await entitlementDb._resetDbForTests();
  const buyer = await add("15550000001", "b1", "WTB Rolex Daytona 126500LN");
  await add("15550000001", "b2", "WTB Patek Philippe 5712G");
  const seller = await add("15550000002", "s1", "FS Rolex Daytona 126500LN $28000");
  await add("15550000003", "s2", "FS Patek Philippe 5712G $90000");
  await markPaid("15550000001", "15550000002", "15550000003");
  await db.withSchema((pool) => pool.query(`INSERT INTO matches (fs_posting_id, wtb_posting_id) VALUES ($1,$2)`, [seller.posting!.id, buyer.posting!.id]));

  const sent: string[] = [];
  t.mock.method(whapi, "sendText", async (_phone: string, message: string) => { sent.push(message); });
  const results = await Promise.all([updates.runMarketUpdates("morning", "2026-08-29"), updates.runMarketUpdates("morning", "2026-08-29")]);
  assert.equal(results[0].sent + results[1].sent, 3);
  assert.equal(sent.length, 3, "one digest per eligible user across overlapping replica ticks");
  const digest = sent.find((message) => message.includes("126500LN — your search"))!;
  assert.match(digest, /5712G — your search/);
  assert.match(digest, /New matches since your last update: 1/);
  assert.doesNotMatch(digest, /1555|\$28000|contact|group|budget/i);

  const usage = await db.withSchema((pool) => Promise.all([
    pool.query(`SELECT count(*)::int count FROM approvals`), pool.query(`SELECT count(*)::int count FROM billing_ledger`),
    pool.query(`SELECT total_approved_count FROM canonical_users WHERE id=$1`, [buyer.posting!.canonical_user_id]),
  ]));
  assert.deepEqual(usage.map((r) => Number(r.rows[0].count ?? r.rows[0].total_approved_count)), [0, 0, 0]);
  assert.equal((await updates.runMarketUpdates("morning", "2026-08-29")).sent, 0, "persistent key survives repeated/restart-equivalent ticks");

  await add("15550000004", "s3", "FS Rolex Daytona 126500LN $29000");
  await markPaid("15550000004");
  t.mock.restoreAll();
  let failOnce = true;
  t.mock.method(whapi, "sendText", async () => { if (failOnce) { failOnce = false; throw new Error("transient"); } });
  assert.equal((await updates.runMarketUpdates("afternoon", "2026-08-29")).failed, 1);
  assert.ok((await updates.runMarketUpdates("afternoon", "2026-08-29")).sent >= 1, "failed delivery is retryable");
});
