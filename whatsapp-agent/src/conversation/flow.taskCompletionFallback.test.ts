import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Real reported pattern: the generic "I'm not sure I understood that" fallback kept appearing
 * right after Fi had just finished something (a confirmed listing, an approve/pass decision) --
 * most often the very next message being a stray, content-less phantom companion (see
 * stateStore.ts's isSuspectedPhantomCompanion) with nothing to parse. That reads as confusion
 * about the job Fi had just done, not as an unrelated new message that happened not to parse, so
 * the very next unparseable reply after a completed task gets a friendlier "Anything else I can
 * help you with today?" instead -- strictly one-shot, never carried past that single reply.
 */
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-taskcompletion-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
// Must be set before config.ts is ever required (transitively, via ./flow below) -- config.ts
// reads process.env once at module load, so setting these inside a test body would be too late
// for isAuthorizeNetConfigured() to ever see them. Just enough to make it true -- no live call
// happens in this file (createCheckoutSession never calls Authorize.net itself).
process.env.AUTHORIZENET_API_LOGIN_ID = "test-login-id";
process.env.AUTHORIZENET_TRANSACTION_KEY = "test-transaction-key";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../channels/greenApi") as typeof import("../channels/greenApi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

const UNPARSEABLE = "asdkfj not a real command";
const CANNED_FALLBACK = /not sure I understood/i;
const ANYTHING_ELSE = /Anything else I can help you with today\?/;

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
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
    contactPhone: "17775559999",
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

test("required regression: a message with nothing to parse, with no prior completion, still gets the old canned fallback", async () => {
  const phone = "15550008001";
  resetState(phone);
  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(result.messages.join("\n"), CANNED_FALLBACK);
  assert.doesNotMatch(result.messages.join("\n"), ANYTHING_ELSE);
});

test("required regression: confirming a WTB draft, then an unparseable reply gets 'Anything else...' instead of the confused canned fallback, one-shot only", async (t) => {
  const phone = "15550008002";
  resetState(phone);
  const ingest = require("../postings/ingest") as typeof import("../postings/ingest");
  t.mock.method(ingest, "ingestDirectBuyPosting", async (input: import("../postings/postingsStore").DirectSellPostingInput) => ({
    matchesFound: 0,
    posting: {
      type: "WTB", brand: input.brand ?? "", model: input.model ?? "", reference: input.reference ?? "", dial: input.dialColor ?? "",
      condition: input.condition ?? "", price: input.price === null ? null : String(input.price), currency: input.currency ?? "USD", location: input.location ?? "",
    } as import("../postings/postingsStore").PostingRow,
  }));

  await handleIncomingMessage(phone, "WTB Rolex 116500LN white dial pre-owned in the US for $28,000");
  const confirmed = await handleIncomingMessage(phone, "yes");
  assert.equal(confirmed.state.pendingBuyIntake, undefined, "precondition: the draft actually confirmed");

  const phantom = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(phantom.messages.join("\n"), ANYTHING_ELSE);
  assert.doesNotMatch(phantom.messages.join("\n"), CANNED_FALLBACK);

  // One-shot: a SECOND unparseable reply right after must go back to the normal canned fallback.
  const again = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(again.messages.join("\n"), CANNED_FALLBACK);
  assert.doesNotMatch(again.messages.join("\n"), ANYTHING_ELSE);
});

test("required regression: approving a match, then an unparseable reply gets 'Anything else...'", async (t) => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("approve-completion-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const phone = "19990003001";
  resetState(phone);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const searched = await handleIncomingMessage(phone, "any");
  assert.ok(searched.state.pendingMatches, "precondition: a match set is now pending");

  const approved = await handleIncomingMessage(phone, "approve 1");
  assert.match(approved.messages.join("\n"), /Approved #1/);

  const phantom = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(phantom.messages.join("\n"), ANYTHING_ELSE);
  assert.doesNotMatch(phantom.messages.join("\n"), CANNED_FALLBACK);
});

test('required regression: "join" (with Authorize.net configured) sending a payment link, then an unparseable reply gets \'Anything else...\' -- live-reported: a phantom companion webhook right after the payment link read as Fi being confused about the link it had just sent', async () => {
  const phone = "19990003003";
  resetState(phone);
  await handleIncomingMessage(phone, "hi"); // move past first-contact onboarding first

  const joined = await handleIncomingMessage(phone, "join");
  assert.match(joined.messages.join("\n"), /\/pay\//, "precondition: a real checkout link was sent");

  const phantom = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(phantom.messages.join("\n"), ANYTHING_ELSE);
  assert.doesNotMatch(phantom.messages.join("\n"), CANNED_FALLBACK);
});

test("required regression: passing on a match, then an unparseable reply gets 'Anything else...'", async (t) => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("pass-completion-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const phone = "19990003002";
  resetState(phone);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");

  const passed = await handleIncomingMessage(phone, "pass 1");
  assert.match(passed.messages.join("\n"), /Passing on #1/);

  const phantom = await handleIncomingMessage(phone, UNPARSEABLE);
  assert.match(phantom.messages.join("\n"), ANYTHING_ELSE);
  assert.doesNotMatch(phantom.messages.join("\n"), CANNED_FALLBACK);
});
