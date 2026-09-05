import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The v4 postings path is off by default (see config.postingsV4) — these integration tests
// exercise it end to end, so they explicitly opt in. Must be set before config.ts (and
// therefore every module below) is first required.
//
// Isolate PERSIST_DIR to a temp dir: handleGroupMessage's v3 CSV capture
// (groupMonitor.ts's appendGroupListing) writes real rows to disk on every group-post test
// below, and inventoryDb.ts's getActiveListings() merges that same CSV into its own results —
// without this isolation, those rows leak into the repo's real ./persist and silently
// corrupt unrelated inventoryDb/syncInventory test assertions run later in the same suite.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-postings-integration-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
// All these tests post into group "g1" — "*" opts every group in so this file exercises the
// matching/ingestion behavior itself, independent of the controlled-rollout allowlist (that's
// covered separately in config.allowedChatIds.test.ts and groupMonitor.featureFlag.test.ts).
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ingestModule = require("./ingest") as typeof import("./ingest");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const groupMonitor = require("../conversation/groupMonitor") as typeof import("../conversation/groupMonitor");

const { ingestAndMatch, ingestApiFsSync } = ingestModule;
const { handleGroupMessage } = groupMonitor;

after(async () => {
  await db._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function apiFsListing(overrides: Partial<Parameters<typeof ingestApiFsSync>[0][number]> = {}) {
  return {
    id: "wf-1",
    item: "Rolex Daytona",
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$28,000",
    contactName: "WatchFacts Seller",
    contactPhone: "10000000000",
    detailUrl: "https://watchfacts.com/flash-sales/wf-1",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

function watchTb(overrides: Partial<Parameters<typeof ingestAndMatch>[0]> = {}) {
  return {
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "buyer-1",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
    ...overrides,
  };
}

function watchFs(overrides: Partial<Parameters<typeof ingestAndMatch>[0]> = {}) {
  return {
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "seller-1",
    text: "FS Rolex Daytona 116500LN $28,000",
    ...overrides,
  };
}

function mockSends(t: TestContext): { phone: string; message: string }[] {
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });
  return sent;
}

test("requirement: a chat WTB immediately matches an existing live WatchFacts FS listing already in postings", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestApiFsSync([apiFsListing()]); // simulates a WatchFacts sync that already completed

  await ingestAndMatch(watchTb());

  const matchMsg = sent.find((s) => s.phone === "buyer-1" && /Potential Match/.test(s.message));
  assert.ok(matchMsg, "the buyer should be notified of a match against the live WatchFacts FS listing");
  assert.match(matchMsg!.message, /WatchFacts Seller/);
});

test("requirement: a WatchFacts FS sync (new listing) triggers a match against an existing chat WTB monitor", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestAndMatch(watchTb({ senderIdentity: "buyer-2" }));
  sent.length = 0; // clear the "monitoring" acknowledgment noise from the line above

  await ingestApiFsSync([apiFsListing({ id: "wf-2" })]); // the sync that should reverse-match

  const matchMsg = sent.find((s) => s.phone === "buyer-2" && /Potential Match/.test(s.message));
  assert.ok(matchMsg, "a fresh FS sync must reverse-match against the already-active chat WTB monitor");
});

test("required regression: a WatchFacts WTB sync (real dealer buy request) triggers a match against an existing chat FS listing — the gap where WatchFacts demand never reached real matching at all", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestAndMatch(watchFs({ senderIdentity: "seller-1" }));
  sent.length = 0; // clear the "monitoring" acknowledgment noise from the line above

  await ingestModule.ingestApiWtbSync([
    apiFsListing({ id: "wf-wtb-1", contactName: "WatchFacts Dealer", contactPhone: "20000000000", price: "$30,000" }),
  ]);

  const matchMsg = sent.find((s) => s.phone === "seller-1" && /Potential Match/.test(s.message));
  assert.ok(matchMsg, "a fresh WTB sync must reverse-match against the already-active chat FS listing");
});

test("required regression: a chat FS listing already in postings is immediately matched when a WatchFacts WTB sync runs, mirroring the existing chat-WTB-vs-WatchFacts-FS requirement above", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestModule.ingestApiWtbSync([apiFsListing({ id: "wf-wtb-2", contactName: "WatchFacts Dealer", contactPhone: "20000000001", price: "$30,000" })]); // simulates a completed WatchFacts WTB sync

  await ingestAndMatch(watchFs({ senderIdentity: "seller-2" }));

  const matchMsg = sent.find((s) => s.phone === "seller-2" && /Potential Match/.test(s.message));
  assert.ok(matchMsg, "the seller should be notified of a match against the live WatchFacts WTB demand");
});

test("requirement: chat FS and chat WTB match each other directly, with no API listing involved", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestAndMatch(watchFs());
  await ingestAndMatch(watchTb({ senderIdentity: "buyer-3" }));

  assert.ok(sent.some((s) => s.phone === "buyer-3" && /Potential Match/.test(s.message)), "buyer should be notified");
  assert.ok(sent.some((s) => s.phone === "seller-1" && /Potential Match/.test(s.message)), "seller should be notified");
});

test("requirement: a duplicate chat webhook redelivery does not produce a duplicate match notification", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  const input = watchTb({ senderIdentity: "buyer-4" });
  await ingestApiFsSync([apiFsListing({ id: "wf-dup" })]);

  await ingestAndMatch(input);
  assert.equal(sent.filter((s) => /Potential Match/.test(s.message)).length, 1);

  await ingestAndMatch(input); // exact duplicate webhook redelivery — same messageId, same text
  assert.equal(
    sent.filter((s) => /Potential Match/.test(s.message)).length,
    1,
    "a duplicate webhook must never re-send the match notification"
  );
});

test("requirement: a repeated, unchanged WatchFacts FS sync does not produce a duplicate match notification", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestAndMatch(watchTb({ senderIdentity: "buyer-5" }));
  sent.length = 0;

  const listing = apiFsListing({ id: "wf-repeat" });
  await ingestApiFsSync([listing]);
  assert.equal(sent.filter((s) => /Potential Match/.test(s.message)).length, 1);

  await ingestApiFsSync([listing]); // identical re-sync, listing unchanged
  assert.equal(
    sent.filter((s) => /Potential Match/.test(s.message)).length,
    1,
    "an unchanged re-sync must never re-trigger the match notification"
  );
});

test("requirement: v3's silent CSV capture and v4's dual-write ingestion never both send a message for the same group post", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  // No FS counterpart exists yet — the only possible message is v4's own "monitoring"
  // acknowledgment. v3 group handling (appendGroupListing) never sends into or out of a
  // group by design, so there is nothing else that could double up here.
  await handleGroupMessage("m1", "g1", "buyer-6", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");
  assert.equal(sent.length, 1, "exactly one message for a fresh, unmatched group post");
  assert.match(sent[0].message, /monitoring this request/i);
});

test("requirement: once a match exists, a group post gets the match notification instead of an extra acknowledgment", async (t) => {
  await db._resetDbForTests();
  const sent = mockSends(t);

  await ingestApiFsSync([apiFsListing({ id: "wf-group-match" })]);
  await handleGroupMessage("m2", "g1", "buyer-7", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");

  assert.equal(sent.length, 1, "a match found on ingestion produces exactly one message, not an ack plus a notification");
  assert.match(sent[0].message, /Potential Match/);
});
