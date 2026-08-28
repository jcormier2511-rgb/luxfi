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
