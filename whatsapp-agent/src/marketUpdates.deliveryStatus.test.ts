import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

const persist = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-market-delivery-status-"));
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

test("getMarketUpdateDeliveryStatus reports 'never delivered, no failures' against a freshly migrated schema", async () => {
  await db._resetDbForTests();
  await entitlementDb._resetDbForTests();
  const status = await updates.getMarketUpdateDeliveryStatus();
  assert.deepEqual(status, {
    lastDeliveredAt: null,
    lastPeriod: null,
    lastLocalDate: null,
    recipientsInLastBatch: 0,
    lastFailureAt: null,
    lastFailureError: null,
  });
});

test("getMarketUpdateDeliveryStatus reflects a real successful run: timestamp, period, and recipient count in that batch", async (t) => {
  await db._resetDbForTests();
  await entitlementDb._resetDbForTests();
  await store.ingestChatPosting({ platform: "whatsapp", chatId: "market", messageId: "b1", senderIdentity: "15550000001", text: "WTB Rolex Daytona 126500LN" });
  await store.ingestChatPosting({ platform: "whatsapp", chatId: "market", messageId: "s1", senderIdentity: "15550000002", text: "FS Rolex Daytona 126500LN $28000" });

  t.mock.method(whapi, "sendText", async () => {});
  const run = await updates.runMarketUpdates("morning", "2026-08-30");
  assert.equal(run.sent, 2);

  const status = await updates.getMarketUpdateDeliveryStatus();
  assert.equal(status.lastPeriod, "morning");
  assert.equal(status.lastLocalDate, "2026-08-30");
  assert.equal(status.recipientsInLastBatch, 2);
  assert.ok(status.lastDeliveredAt, "must report a real ISO timestamp for the last delivery");
  assert.doesNotThrow(() => new Date(status.lastDeliveredAt!).toISOString());
  assert.equal(status.lastFailureAt, null, "a clean run must not report a stale/unrelated failure");
});

test("getMarketUpdateDeliveryStatus separately reports the most recent failure without being cleared by an unrelated later success", async (t) => {
  await db._resetDbForTests();
  await entitlementDb._resetDbForTests();
  await store.ingestChatPosting({ platform: "whatsapp", chatId: "market", messageId: "b1", senderIdentity: "15550000001", text: "WTB Rolex Daytona 126500LN" });
  await store.ingestChatPosting({ platform: "whatsapp", chatId: "market", messageId: "s1", senderIdentity: "15550000002", text: "FS Rolex Daytona 126500LN $28000" });

  t.mock.method(whapi, "sendText", async () => {
    throw new Error("simulated whapi outage");
  });
  const failedRun = await updates.runMarketUpdates("morning", "2026-08-30");
  assert.equal(failedRun.failed, 2);

  const afterFailure = await updates.getMarketUpdateDeliveryStatus();
  assert.equal(afterFailure.lastDeliveredAt, null, "a failed send is never reported as a delivery");
  assert.ok(afterFailure.lastFailureAt);
  assert.equal(afterFailure.lastFailureError, "Error: simulated whapi outage");

  // A different (unrelated) delivery window succeeding — never retrying the failed morning
  // window itself — must not clear or overwrite that morning failure's own record, since it's
  // a distinct row (canonical_user_id, period, local_date, timezone) in the ledger.
  t.mock.restoreAll();
  t.mock.method(whapi, "sendText", async () => {});
  const afternoonRun = await updates.runMarketUpdates("afternoon", "2026-08-30");
  assert.equal(afternoonRun.sent, 2);

  const afterUnrelatedSuccess = await updates.getMarketUpdateDeliveryStatus();
  assert.equal(afterUnrelatedSuccess.lastPeriod, "afternoon", "the newer, unrelated success is now the most recent delivery");
  assert.ok(afterUnrelatedSuccess.lastDeliveredAt);
  assert.ok(afterUnrelatedSuccess.lastFailureAt, "the untouched morning failure must still be visible, not erased by the later, unrelated success");
  assert.equal(afterUnrelatedSuccess.lastFailureError, "Error: simulated whapi outage");
});
