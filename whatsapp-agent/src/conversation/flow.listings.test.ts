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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createDirectPosting, closePosting } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");

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
  assert.match(joined, /You currently have 1 active task/);
  assert.match(joined, /FS —/);
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
  assert.match(result.messages.join("\n"), /don’t have any active buy or sell tasks/i);
});

test('natural "what are my listings" returns numbered active FS and WTB structured tasks and excludes inactive tasks', async () => {
  const phone = "19992230011";
  resetState(phone);
  await postingsDb._resetDbForTests();
  await createDirectPosting({ phone, type: "FS", description: "raw text must not be displayed", brand: "Rolex", model: "Daytona", reference: "126500LN", dialColor: "White", condition: "Used", price: 38000, currency: "USD", location: "Miami" });
  await createDirectPosting({ phone, type: "WTB", description: "different raw text", brand: "Rolex", model: "Daytona", reference: "116500LN", dialColor: "Black", price: 28500, currency: "USD", location: "USA" });
  const closed = await createDirectPosting({ phone, type: "FS", description: "closed watch", brand: "Patek Philippe", reference: "5711", price: 90000 });
  await closePosting(closed.id, "sold");

  const result = await handleIncomingMessage(phone, "what are my listings");
  const text = result.messages.join("\n");
  assert.match(text, /You currently have 2 active tasks:/);
  const fsNumber = text.match(/(\d+)\. FS — Rolex Daytona 126500LN\nWhite dial\nUsed\nAsking: \$38,000\nMiami/)?.[1];
  const wtbNumber = text.match(/(\d+)\. WTB — Rolex Daytona 116500LN\nBlack dial\nBudget: \$28,500\nUSA/)?.[1];
  assert.ok(fsNumber, "the active FS is numbered and contains all persisted structured fields");
  assert.ok(wtbNumber, "the active WTB is numbered and contains all persisted structured fields");
  assert.notEqual(fsNumber, wtbNumber, "each active listing has a unique list number");
  assert.deepEqual(new Set([fsNumber, wtbNumber]), new Set(["1", "2"]), "two active listings occupy numbers 1 and 2");
  assert.doesNotMatch(text, /5711|raw text|different raw text/);
  assert.match(text, /You can say:[\s\S]*change listing 2 price[\s\S]*expand listing 1[\s\S]*pause listing 1[\s\S]*close listing 2/);
  assert.doesNotMatch(text, /Try "buy:/, "management queries never reach the generic fallback");
});

test("natural listing-management variants use the same behavior for WhatsApp and Telegram identities", async () => {
  await postingsDb._resetDbForTests();
  const identities = ["19992230012", "telegram:9230012"];
  for (const phone of identities) {
    resetState(phone);
    await createDirectPosting({ phone, type: "FS", description: "Omega Speedmaster", brand: "Omega", model: "Speedmaster", reference: "310.30", price: 7000 });
  }
  for (const [phone, query] of [
    [identities[0], "show my FS"],
    [identities[0], "i need to edit my listings"],
    [identities[1], "what are you monitoring for me"],
  ]) {
    const result = await handleIncomingMessage(phone, query);
    assert.match(result.messages.join("\n"), /1\. FS — Omega Speedmaster 310\.30/);
    assert.doesNotMatch(result.messages.join("\n"), /Try "buy:/);
  }
});

test("natural listing-management query returns the exact empty state", async () => {
  const phone = "19992230013";
  resetState(phone);
  await postingsDb._resetDbForTests();
  const result = await handleIncomingMessage(phone, "my active tasks");
  assert.equal(result.messages.join("\n"), "You don’t have any active buy or sell tasks right now.\nTell me what you want to buy or sell and I’ll start working on it.");
});

test("listing management overrides a pending WTB and legacy filler is hidden", async () => {
  const phone = "19992230014";
  resetState(phone);
  await postingsDb._resetDbForTests();
  await createDirectPosting({ phone, type: "FS", description: "first", brand: "Omega", model: "Speedmaster", reference: null, price: 7000 });
  await createDirectPosting({ phone, type: "WTB", description: "legacy raw text", brand: "rolex", model: "only", reference: null, price: 25000 });
  await createDirectPosting({ phone, type: "FS", description: "third", brand: "Cartier", model: "Santos", reference: null, price: 8000 });

  const draft = await handleIncomingMessage(phone, "WTB Patek");
  const pendingBuyBefore = structuredClone(draft.state.pendingBuyIntake);
  const pendingSellBefore = structuredClone(draft.state.pendingSellIntake);
  const listed = await handleIncomingMessage(phone, "my listings");
  assert.match(listed.messages.join("\n"), /2\. WTB — Rolex(?:\n|$)/);
  assert.doesNotMatch(listed.messages.join("\n"), /Rolex only|Model: only/i);

  const closed = await handleIncomingMessage(phone, "closing listing 3");
  assert.match(closed.messages.join("\n"), /Listing 3 closed:/);
  assert.deepEqual(closed.state.pendingBuyIntake, pendingBuyBefore, "listing management must not consume or alter the WTB draft");
  assert.deepEqual(closed.state.pendingSellIntake, pendingSellBefore, "listing management must not alter sell intake state");

  const completed = await handleIncomingMessage(phone, "WTB i want to buy a rolex, preowned, usa, maximum $25,000");
  assert.equal(completed.state.pendingBuyIntake?.brand, "rolex");
  assert.equal(completed.state.pendingBuyIntake?.model, undefined);
  assert.equal(completed.state.pendingBuyIntake?.reference, null);
  assert.equal(completed.state.pendingBuyIntake?.condition, "pre-owned");
  assert.equal(completed.state.pendingBuyIntake?.budget, 25000);
  assert.equal(completed.state.pendingBuyIntake?.location, "USA");
  assert.doesNotMatch(completed.messages.join("\n"), /Model: (?:i want to buy a|only)/i);
});

test("pause, resume, and price changes preserve a pending WTB exactly", async () => {
  const phone = "19992230015";
  resetState(phone);
  await postingsDb._resetDbForTests();
  await createDirectPosting({ phone, type: "FS", description: "Rolex Explorer", brand: "Rolex", model: "Explorer", reference: null, price: 9000 });

  const draft = await handleIncomingMessage(phone, "WTB Patek");
  const pendingBuyBefore = structuredClone(draft.state.pendingBuyIntake);
  const pendingSellBefore = structuredClone(draft.state.pendingSellIntake);

  for (const [command, confirmation] of [
    ["pause listing 1", /Listing 1 paused:/],
    ["resume listing 1", /Listing 1 resumed:/],
    ["change listing 1 price to 35000", /Updated:/],
  ] as const) {
    const result = await handleIncomingMessage(phone, command);
    assert.match(result.messages.join("\n"), confirmation);
    assert.deepEqual(result.state.pendingBuyIntake, pendingBuyBefore, `${command} must not alter the WTB draft`);
    assert.deepEqual(result.state.pendingSellIntake, pendingSellBefore, `${command} must not alter sell intake state`);
  }
});
