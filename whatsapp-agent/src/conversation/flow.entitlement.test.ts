import { test, after } from "node:test";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
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

/** Drives one search + one approve for a fresh contact, seeding preferences with "any" each time. */
async function searchAndApprove(phone: string, firstSearch: boolean): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);

  if (firstSearch) push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, "buy: Rolex Daytona"));
  if (firstSearch) {
    push(await handleIncomingMessage(phone, "any")); // price
    push(await handleIncomingMessage(phone, "any")); // location
    push(await handleIncomingMessage(phone, "any")); // dial
    push(await handleIncomingMessage(phone, "any")); // condition
  }
  push(await handleIncomingMessage(phone, "approve 1"));
  return collected;
}

test("approvals lock after the 3rd complimentary one, and only an admin override unlocks more", async () => {
  await inventoryDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const phone = "19990000001";

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

test("searching and passing stay unrestricted even while approvals are locked", async () => {
  await inventoryDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const phone = "19990000002";

  await inventoryDb.upsertListings([fsRow("search-1")], new Date().toISOString());

  // Burn through the trial first.
  for (let i = 0; i < 3; i++) {
    await searchAndApprove(phone, i === 0);
  }

  // Now locked — but a new search and a "pass" must still work normally.
  const searchResult = await handleIncomingMessage(phone, "buy: Rolex Daytona");
  assert.ok(searchResult.messages.some((m) => /Potential Match/.test(m)), "search must still work while locked");

  const passResult = await handleIncomingMessage(phone, "pass 1");
  assert.ok(passResult.messages.some((m) => /Passing on #1/.test(m)), "pass must still work while locked");
});
