import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-commands-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlementStore = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await entitlementStore._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "28000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

test('required: "help" shows the Fi menu', async () => {
  resetState("19991110001");
  const result = await handleIncomingMessage("19991110001", "help");
  assert.match(result.messages[0], /here's what I can do/i);
  assert.match(result.messages[0], /"cancel"/);
  assert.match(result.messages[0], /"status"/);
});

test('"menu" is a synonym for "help"', async () => {
  resetState("19991110002");
  const result = await handleIncomingMessage("19991110002", "menu");
  assert.match(result.messages[0], /here's what I can do/i);
});

test('required: "status" reports approval usage and pending decisions honestly, without guessing', async () => {
  resetState("19991110003");
  const result = await handleIncomingMessage("19991110003", "status");
  assert.match(result.messages[0], /Approved matches: 0\/3/);
  assert.match(result.messages[0], /No matches currently awaiting a decision/);
});

test('required: "cancel" clears a pending match without unsubscribing the contact', async () => {
  const phone = "19991110004";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("cancel-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const searchResult = await handleIncomingMessage(phone, "any");
  assert.ok(searchResult.state.pendingMatches, "a match must be pending before cancel is tested");

  const cancelResult = await handleIncomingMessage(phone, "cancel");
  assert.match(cancelResult.messages[0], /cleared your current matches/i);
  assert.equal(cancelResult.state.pendingMatches, undefined);
  assert.notEqual(cancelResult.state.stage, "opted_out", "cancel must never unsubscribe the contact");

  // Still a fully active contact afterward -- a new search works normally.
  const stillActive = await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  assert.ok(stillActive.messages.some((m) => /Potential Match/.test(m)));
});

test('"cancel" with nothing pending says so rather than pretending something was cleared', async () => {
  resetState("19991110005");
  const result = await handleIncomingMessage("19991110005", "cancel");
  assert.match(result.messages[0], /nothing pending to cancel/i);
});

test('required (live-reported bug): after the only match is already approved, "hi" gets a personalized greeting, not the stale approve/pass reminder', async () => {
  const phone = "19991110006";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("hi-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const approve = await handleIncomingMessage(phone, "approve 1");
  assert.match(approve.messages.join("\n"), /^Approved #1/);

  const hiResult = await handleIncomingMessage(phone, "hi", { phone, name: "John Smith", tier: "A" });
  assert.match(hiResult.messages[0], /^Hi John, how can I help you today\?$/);
  assert.doesNotMatch(hiResult.messages[0], /approve <number>/i, "must never show the stale reminder once nothing is left to decide");
});

test('required (live-reported bug): "Photos2" and "approve1" (no space before the number) are recognized the same as with a space', async () => {
  const phone = "19991110007";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("nospace-1", { contactPhone: "10000000001" }), fsRow("nospace-2", { contactPhone: "10000000002" })],
    new Date().toISOString()
  );

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const search = await handleIncomingMessage(phone, "any");
  assert.equal(search.state.pendingMatches!.matches.length, 2, "setup: two candidates must be shown");

  const photosNoSpace = await handleIncomingMessage(phone, "Photos2");
  assert.match(photosNoSpace.messages.join("\n"), /Photo request sent for #2/, '"Photos2" must resolve to match #2, not fall through to general chat');

  const approveNoSpace = await handleIncomingMessage(phone, "approve1");
  assert.match(approveNoSpace.messages.join("\n"), /^Approved #1/, '"approve1" must resolve to match #1');
});
