import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-sellintake-persist-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

const SELLER_PHONE = "17775555001";
const BUYER_PHONE = "17775555002";
const SELLER_PHONE_NO_PHOTO = "17775555003";

/** Same pattern as flow.sellIntake.test.ts's freshRequest — walks a brand-new contact through
 *  the once-per-contact price/location/dial/condition interview with "any", then returns the
 *  search's own result (the turn that actually reaches startSearch/startSellIntake). */
async function freshRequest(phone: string, query: string) {
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, query);
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  return handleIncomingMessage(phone, "any");
}

test("required regression: a completed sell-intake is persisted as a live FS listing a later buyer search can find", async () => {
  resetState(SELLER_PHONE);
  resetState(BUYER_PHONE);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  await handleIncomingMessage(SELLER_PHONE, "hi");
  const photoPrompt = await handleIncomingMessage(SELLER_PHONE, "FS Rolex Daytona 116500LN persistence-findable-listing black dial pre-owned in USA for 28500");
  assert.match(photoPrompt.messages.join("\n"), /attach a photo/i);
  const summary = await handleIncomingMessage(SELLER_PHONE, "photo attached", undefined, "https://example.com/daytona.jpg");
  assert.match(summary.messages.join("\n"), /Photo: attached[\s\S]*Should I start monitoring\?/);
  assert.equal((await inventoryDb.getActiveListings("FS")).length, 0, "draft and photo are not saved before confirmation");
  const finished = await handleIncomingMessage(SELLER_PHONE, "yes");
  assert.match(finished.messages.join("\n"), /listing is active/i);

  const active = await inventoryDb.getActiveListings("FS");
  const found = active.find((l) => l.item.includes("persistence-findable-listing"));
  assert.ok(found, "the completed sell-intake must be persisted as an active FS row, not just left in conversation state");
  assert.equal(found!.contactPhone, SELLER_PHONE);
  assert.equal(found!.imageUrl, "https://example.com/daytona.jpg");
  assert.equal(found!.price, "28500");
  assert.equal(found!.source, "WA-DM");

  // A buyer's ordinary "buy:" search must actually surface it, same as any other inventory row.
  const buyerResult = await freshRequest(BUYER_PHONE, "buy: Rolex Daytona 116500LN");
  const buyerMessages = buyerResult.messages.join("\n");
  assert.match(buyerMessages, /persistence-findable-listing/);
  assert.match(buyerMessages, /Private Seller/);
});

test("a sell-intake finished with no photo is still persisted (whatever was collected, not nothing)", async () => {
  resetState(SELLER_PHONE_NO_PHOTO);
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();

  await handleIncomingMessage(SELLER_PHONE_NO_PHOTO, "hi");
  const photoPrompt = await handleIncomingMessage(SELLER_PHONE_NO_PHOTO, "FS Omega Speedmaster 311.30.42.30.01.005 no-photo-listing pre-owned in USA for $12000");
  assert.match(photoPrompt.messages.join("\n"), /attach a photo/i);
  const summary = await handleIncomingMessage(SELLER_PHONE_NO_PHOTO, "no photo");
  assert.match(summary.messages.join("\n"), /Photo: none[\s\S]*Should I start monitoring\?/);
  await handleIncomingMessage(SELLER_PHONE_NO_PHOTO, "yes");

  const active = await inventoryDb.getActiveListings("FS");
  const found = active.find((l) => l.item.includes("no-photo-listing"));
  assert.ok(found, "still persisted even without a photo — the seller answered every question asked");
  assert.equal(found!.imageUrl, undefined);
  assert.equal(found!.price, "12000");
});
