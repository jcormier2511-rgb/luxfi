import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Real reported gap: no single command showed "everything I'm involved in" — approved
// matches, still-pending matches, and a seller's/buyer's own active listings — so a contact
// who typed something like "start" mid-conversation just got a generic fallback reminder and
// had no way to get their bearings. "listings" (see conversation/flow.ts) presents a 1/2/3
// menu for exactly those three views.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-listings-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `Rolex Daytona ${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "18500",
    location: "",
    contactName: `Seller ${id}`,
    contactPhone: `seller-${id}`,
    rating: "",
    description: `Rolex Daytona ${id}`,
    ...overrides,
  };
}

/** Same "once-per-contact" interview pattern used throughout this suite. */
async function freshRequest(phone: string, query: string) {
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, query);
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  return handleIncomingMessage(phone, "any");
}

test('required: "listings" shows a 1/2/3 menu, and an unrecognized reply falls through normally instead of nagging again', async () => {
  const phone = "19992230001";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const menu = await handleIncomingMessage(phone, "listings");
  assert.match(menu.messages.join("\n"), /1\. Matches I've approved/);
  assert.match(menu.messages.join("\n"), /2\. Matches still pending my decision/);
  assert.match(menu.messages.join("\n"), /3\. My current WTB\/FS listings/);
  assert.equal(menu.state.pendingListingsMenu, true);

  const junk = await handleIncomingMessage(phone, "banana");
  assert.equal(junk.state.pendingListingsMenu, false, "one-shot: cleared regardless of the reply");
  // Falls through to ordinary handling (a plain unrecognized message), not a repeated menu.
  assert.doesNotMatch(junk.messages.join("\n"), /Matches I've approved/);

  // One-shot really means one-shot: asking again with a stale menu no longer pending must not resurface it.
  const stale = await handleIncomingMessage(phone, "1");
  assert.doesNotMatch(stale.messages.join("\n"), /Your approved matches/);
});

test('required (live-reported bug): natural phrasings like "listing summary" and "my listing" trigger the same menu as "listings"', async () => {
  const phone = "19992230008";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const a = await handleIncomingMessage(phone, "listing summary");
  assert.match(a.messages.join("\n"), /1\. Matches I've approved/);

  const b = await handleIncomingMessage(phone, "my listing");
  assert.match(b.messages.join("\n"), /1\. Matches I've approved/);

  const c = await handleIncomingMessage(phone, "summary");
  assert.match(c.messages.join("\n"), /1\. Matches I've approved/);
});

test('required (live-reported bug): "start" (for a contact who was never opted out) shows the full menu instead of a generic fallback reminder', async () => {
  const phone = "19992230009";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("start-1")], new Date().toISOString());

  // Leave a match pending, exactly like the live-reported scenario — a bare "start" used to
  // just repeat "reply approve/pass... or tell me a new item to search" here.
  await freshRequest(phone, "buy: Rolex Daytona 116500LN");

  const result = await handleIncomingMessage(phone, "start");
  assert.match(result.messages.join("\n"), /here's what I can do/i);
});

test('"start" still reactivates an actually-opted-out contact (unaffected by folding it into the menu command)', async () => {
  const phone = "19992230010";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  const stopped = await handleIncomingMessage(phone, "stop");
  assert.equal(stopped.state.stage, "opted_out");

  const result = await handleIncomingMessage(phone, "start");
  assert.notEqual(result.state.stage, "opted_out", "start must still reactivate an opted-out contact");
});

test("required: option 1 shows an approved match's real contact info (v3 has no confirmation gate — always revealed immediately)", async () => {
  const phone = "19992230002";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("list-1")], new Date().toISOString());

  await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "approve 1");

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "1");
  assert.match(result.messages.join("\n"), /Your approved matches/);
  assert.match(result.messages.join("\n"), /Rolex Daytona list-1/);
  assert.match(result.messages.join("\n"), /Seller list-1: seller-list-1/);
});

test("required: option 1 says nothing has been approved yet when that's true", async () => {
  const phone = "19992230003";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "1");
  assert.match(result.messages.join("\n"), /haven't approved any matches yet/i);
});

test("required: option 2 lists only still-pending matches, keeping their original numbers so approve/pass still works", async () => {
  const phone = "19992230004";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("list-2a"), fsRow("list-2b"), fsRow("list-2c")], new Date().toISOString());

  await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "approve 2"); // decide #2, leave #1 and #3 pending

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "2");
  const joined = result.messages.join("\n");
  assert.match(joined, /^1\. /m, "match #1 (still pending) must keep its original number");
  assert.match(joined, /^3\. /m, "match #3 (still pending) must keep its original number");
  assert.doesNotMatch(joined, /^2\. /m, "match #2 was already decided and must not be listed as pending");
});

test("required: option 2 says nothing is pending once everything has been decided", async () => {
  const phone = "19992230005";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("list-3")], new Date().toISOString());

  await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "approve 1");

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "2");
  assert.match(result.messages.join("\n"), /Nothing is currently awaiting your approve\/pass/i);
});

test("required: option 3 shows a real active listing created via the sell-intake flow", async () => {
  const phone = "19992230006";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "FS Rolex Submariner 116610LV pre-owned in USA for $14,500");
  await handleIncomingMessage(phone, "skip");
  await handleIncomingMessage(phone, "yes");

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "3");
  const joined = result.messages.join("\n");
  assert.match(joined, /Your active listings/);
  assert.match(joined, /\[FS\]/);
  assert.match(joined, /116610LV/);
});

test("required: option 3 says there are no active listings for a contact who has only ever searched (v3 searches are never persisted as monitors)", async () => {
  const phone = "19992230007";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("list-4")], new Date().toISOString());

  await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "approve 1"); // approving doesn't create a monitored posting either

  await handleIncomingMessage(phone, "listings");
  const result = await handleIncomingMessage(phone, "3");
  assert.match(result.messages.join("\n"), /don't have any active WTB or FS listings/i);
});
