import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR to a temp dir so this test's conversation-state JSON file never lands
// in the repo's own ./persist (gitignored, but still stray/confusing to leave behind).
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "19990000001,19990000002";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string): Parameters<typeof inventoryDb.upsertListings>[0][number] {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `Rolex Daytona ${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "18500",
    location: "",
    contactName: `Seller ${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: `Rolex Daytona ${id}`,
  };
}

/** Arms the AI-matching-test-phone ephemeral search path with a confident, fully-specified
 *  intent -- call once per test, before any searchAndApprove call (t.mock.method throws if
 *  mocked twice in the same test). */
function mockConfidentDaytonaIntent(t: TestContext) {
  t.mock.method(intentExtractorModule, "extractIntent", async () => ({
    intent: {
      intent: "buy" as const,
      brand: "Rolex",
      model: "Daytona",
      reference: null,
      dial: "any",
      condition: "any",
      year: null,
      boxPapers: null,
      priceMin: null,
      priceMax: 500000,
      currency: "USD",
      location: "Global",
      searchText: "Rolex Daytona",
      confidence: 0.9,
    },
    priceUnreliable: false,
  }));
}

/** Drives the AI-matching-test-phone ephemeral search path to a completed search, then approves
 *  #1 -- the replacement for the old "buy: X" + a few "any" replies shortcut, which no longer
 *  reaches a v3 search at all (see conversation/flow.ts: `buy:`/`sell:` now creates a monitored
 *  posting like any other conversational request). This test is about the trial/approval
 *  counter, not about the search/follow-up mechanics themselves. */
async function searchAndApprove(phone: string, firstSearch: boolean): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);

  if (firstSearch) push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, "looking for a Rolex Daytona"));
  push(await handleIncomingMessage(phone, "approve 1"));
  return collected;
}

test("approvals lock after the 3rd complimentary one, and only an admin override unlocks more", async (t) => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const phone = "19990000001";
  mockConfidentDaytonaIntent(t);

  await inventoryDb.upsertListings(
    [fsRow("lock-1"), fsRow("lock-2"), fsRow("lock-3"), fsRow("lock-4")],
    new Date().toISOString()
  );

  const first = await searchAndApprove(phone, true);
  assert.ok(first.some((m) => /Approved #1/.test(m)), "1st approval should succeed");

  const second = await searchAndApprove(phone, false);
  assert.ok(second.some((m) => /Approved #1/.test(m)), "2nd approval should succeed");

  const third = await searchAndApprove(phone, false);
  assert.ok(third.some((m) => /Approved #1/.test(m)), "3rd approval should succeed");
  assert.ok(third.some((m) => /Fi Membership/.test(m)), "conversion pitch should fire exactly at the 3rd approval");

  // 4th attempt: trial exhausted, no admin override yet — must be blocked, not approved.
  const fourthBlocked = await searchAndApprove(phone, false);
  assert.ok(!fourthBlocked.some((m) => /Approved #1/.test(m)), "4th approval must be blocked without an override");
  assert.ok(fourthBlocked.some((m) => /Fi member/i.test(m)), "should get the decline message instead");

  // Saying "join" must NOT unlock anything by itself — no live payment processor exists.
  await handleIncomingMessage(phone, "join");
  const entitlementAfterJoin = await entitlements.getEntitlement(phone);
  assert.equal(entitlementAfterJoin.manualOverrideEnabled, false, "join must never self-unlock");
  assert.equal(entitlementAfterJoin.paymentStatus, "requested", "join should still record intent for an admin to review");

  const stillBlocked = await searchAndApprove(phone, false);
  assert.ok(!stillBlocked.some((m) => /Approved #1/.test(m)), "still blocked after 'join' alone");

  // The ONLY way to unlock: an explicit admin action.
  await entitlements.setManualOverride(phone, true);
  const afterOverride = await searchAndApprove(phone, false);
  assert.ok(afterOverride.some((m) => /Approved #1/.test(m)), "approval should succeed once an admin enables the override");
});

test("searching and passing stay unrestricted even while approvals are locked", async (t) => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const phone = "19990000002";
  mockConfidentDaytonaIntent(t);

  await inventoryDb.upsertListings([fsRow("search-1")], new Date().toISOString());

  // Burn through the trial first.
  for (let i = 0; i < 3; i++) {
    await searchAndApprove(phone, i === 0);
  }

  // Now locked — but a new search and a "pass" must still work normally.
  const searchResult = await handleIncomingMessage(phone, "looking for a Rolex Daytona");
  assert.ok(searchResult.messages.some((m) => /Potential Match/.test(m)), "search must still work while locked");

  const passResult = await handleIncomingMessage(phone, "pass 1");
  assert.ok(passResult.messages.some((m) => /Passing on #1/.test(m)), "pass must still work while locked");
});
