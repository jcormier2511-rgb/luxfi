import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Notification delivery (and therefore match_recipients.notified_at) is allowlist-gated at
// send time — these tests post into chat "g1", so v4 needs to be enabled for it here too,
// same as notify.fiveApproval.test.ts.
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const matching = require("./matching") as typeof import("./matching");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require("./status") as typeof import("./status");
const { ingestChatPosting } = store;
const { runReconciliation, runImmediateMatch } = matching;
const { recordNotificationFailure, getV4OperationalStatus } = status;

after(() => db._closePoolForTests());

test("getV4OperationalStatus counts active FS/WTB monitors and distinguishes chat-originated from API", async () => {
  await db._resetDbForTests();
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Patek 5711 budget $80,000",
  });
  await store.mirrorApiFsPosting({
    id: "wf-1",
    item: "Omega Speedmaster",
    brand: "Omega",
    ref: "311.30.42.30.01.005",
    condition: "New",
    price: "6500",
    contactName: "Dealer",
    contactPhone: "999",
    detailUrl: "https://watchfacts.com/flash-sales/wf-1",
    description: "Omega Speedmaster",
    imageUrl: null,
  });

  const result = await getV4OperationalStatus();
  assert.equal(result.activeFsMonitors, 2, "one chat FS + one API-mirrored FS");
  assert.equal(result.activeWtbMonitors, 1);
  assert.equal(result.chatOriginatedActiveFs, 1, "only the chat FS, not the API-mirrored one");
  assert.equal(result.chatOriginatedActiveWtb, 1);
});

test("getV4OperationalStatus counts a match as active only while both its postings are still active", async () => {
  await db._resetDbForTests();
  const fs = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await runImmediateMatch(wtb.posting!);

  const beforeClose = await getV4OperationalStatus();
  assert.equal(beforeClose.activeMatches, 1);

  await store.closePosting(fs.posting!.id, "sold");
  const afterClose = await getV4OperationalStatus();
  assert.equal(afterClose.activeMatches, 0, "a match whose FS side has been closed is no longer an active match");
});

test("getV4OperationalStatus reports the real notified count from match_recipients", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  await runImmediateMatch(wtb.posting!);

  const result = await getV4OperationalStatus();
  assert.ok(result.notificationsSent >= 1, "the immediate match above should have notified at least the WTB side");
});

test("required regression: recordNotificationFailure persists a queryable failure count and last error", async () => {
  await db._resetDbForTests();
  const before = await getV4OperationalStatus();
  assert.equal(before.notificationsFailed, 0);
  assert.equal(before.lastNotificationError, null);

  await recordNotificationFailure("simulated Whapi 500");
  await recordNotificationFailure("simulated Whapi 500 again");

  const after = await getV4OperationalStatus();
  assert.equal(after.notificationsFailed, 2);
  assert.equal(after.lastNotificationError, "simulated Whapi 500 again");
  assert.ok(after.lastNotificationErrorAt, "must record when the last failure happened");
});

test("getV4OperationalStatus reports the most recent reconciliation run's outcome", async () => {
  await db._resetDbForTests();
  const before = await getV4OperationalStatus();
  assert.equal(before.lastReconciliation, null, "no reconciliation has run yet");

  await runReconciliation();
  const after = await getV4OperationalStatus();
  assert.ok(after.lastReconciliation);
  assert.equal(after.lastReconciliation!.error, null);
  assert.equal(after.lastReconciliation!.matchesCreated, 0);
});
