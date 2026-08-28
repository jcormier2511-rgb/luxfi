import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Real reported gap: "I want to sell a watch" ran a doomed search against the (disabled) WTB
// feed and just reported "no matches" — the seller's message was never used for anything. A
// "sell" search that finds nothing now collects what Fi actually needs to describe the item to
// a future buyer: more detail if the request was vague, a price, and a photo.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-sellintake-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

/** Walks a fresh contact through the once-per-contact preference interview with "any" each
 *  time (same pattern as flow.matching.test.ts), then returns the search's own result. */
async function freshRequest(phone: string, query: string) {
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, query);
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  return handleIncomingMessage(phone, "any");
}

test('required (live-reported bug): "I want to sell a watch" asks for more details first, never just reports "no matches" and stops', async () => {
  const phone = "19992220001";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  const result = await freshRequest(phone, "I want to sell a watch");
  const joined = result.messages.join("\n");
  assert.match(joined, /No live matches yet/, "the zero-result search message must still be shown");
  assert.match(joined, /Tell me a bit more about what you're selling/i);
  assert.equal(result.state.pendingSellIntake?.step, "details");
});

test("required: a specific request (has a reference) skips straight to the price question", async () => {
  const phone = "19992220002";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  const result = await freshRequest(phone, "I want to sell a 116500 white dial");
  const joined = result.messages.join("\n");
  assert.doesNotMatch(joined, /Tell me a bit more/i, "a reference number already identifies the item — no need to ask again");
  assert.match(joined, /What's your asking price\?/);
  assert.equal(result.state.pendingSellIntake?.step, "price");
});

test("required: the full details -> price -> photo flow, ending in a clear acknowledgment", async () => {
  const phone = "19992220003";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  const start = await freshRequest(phone, "I want to sell a watch");
  assert.equal(start.state.pendingSellIntake?.step, "details");

  const afterDetails = await handleIncomingMessage(phone, "It's a Rolex Submariner 116610LV");
  assert.match(afterDetails.messages.join("\n"), /What's your asking price\?/);
  assert.equal(afterDetails.state.pendingSellIntake?.step, "price");
  assert.equal(afterDetails.state.pendingSellIntake?.reference, "116610LV");

  const afterPrice = await handleIncomingMessage(phone, "$14,500");
  assert.match(afterPrice.messages.join("\n"), /Can you send a photo/i);
  assert.equal(afterPrice.state.pendingSellIntake?.step, "photo");
  assert.equal(afterPrice.state.pendingSellIntake?.price, 14500);

  const afterPhoto = await handleIncomingMessage(phone, "here you go", undefined, "https://cdn.example/sub.jpg");
  const summary = afterPhoto.messages.join("\n");
  assert.match(summary, /Asking: \$14,500/);
  assert.match(summary, /Photo: received/);
  assert.equal(afterPhoto.state.pendingSellIntake, undefined, "the intake must be cleared once complete");
});

test("the photo step still finishes cleanly (as 'not provided') when no image ever arrives", async () => {
  const phone = "19992220004";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  await freshRequest(phone, "I want to sell a 5711/1A");
  await handleIncomingMessage(phone, "$85,000");
  const result = await handleIncomingMessage(phone, "sorry, no photo right now");

  assert.match(result.messages.join("\n"), /Photo: not provided/);
  assert.equal(result.state.pendingSellIntake, undefined);
});

test('"cancel" mid-intake clears it without unsubscribing', async () => {
  const phone = "19992220005";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  const start = await freshRequest(phone, "I want to sell a watch");
  assert.ok(start.state.pendingSellIntake);

  const cancelResult = await handleIncomingMessage(phone, "cancel");
  assert.equal(cancelResult.state.pendingSellIntake, undefined);
  assert.notEqual(cancelResult.state.stage, "opted_out");
});

test("a buy search with real matches is completely unaffected by the sell-intake change", async () => {
  const phone = "19992220006";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      {
        id: "buy-unaffected-1",
        type: "FS",
        category: "watches",
        item: "Rolex Daytona 116500LN",
        brand: "Rolex",
        ref: "116500LN",
        condition: "",
        price: "28000",
        location: "",
        contactName: "seller-1",
        contactPhone: "10000000000",
        rating: "",
        description: "Rolex Daytona 116500LN",
      },
    ],
    new Date().toISOString()
  );

  const result = await freshRequest(phone, "buy: Rolex Daytona 116500LN");
  assert.ok(result.messages.some((m) => /Potential Match/.test(m)));
  assert.equal(result.state.pendingSellIntake, undefined);
});
