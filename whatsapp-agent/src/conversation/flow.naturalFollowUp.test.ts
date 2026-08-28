import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Fi Concierge Stage 3: a request must always carry budget/location/dial color/condition, even
// when a single free-form message skipped the old step-by-step interview. Missing pieces are
// asked for once, combined, naming only what's actually missing — never the full interview
// again, and never silently proceeding with unknown gaps either.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-followup-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15550007777";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const queryInterpreterModule = require("../ai/queryInterpreter") as typeof import("../ai/queryInterpreter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rerankModule = require("../ai/rerank") as typeof import("../ai/rerank");

after(async () => {
  await inventoryDb._closePoolForTests();
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
    price: "24500",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

function interpreted(overrides: Partial<Awaited<ReturnType<typeof queryInterpreterModule.interpretQuery>>> = {}) {
  return {
    action: "buy" as const,
    brand: "Rolex",
    referenceFamily: "116500",
    maxPrice: null,
    minPrice: null,
    location: null,
    dialColor: null,
    condition: null,
    hardRequirements: [],
    preferences: [],
    ...overrides,
  };
}

function mockAlwaysMatches(t: { mock: { method: Function } }): void {
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) =>
    candidates.map((c) => ({ id: c.id, explanation: "matches request", evidence: "Rolex Daytona 116500LN" }))
  );
}

test("required regression: a message missing budget and dial color gets ONE combined follow-up question naming just those two", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a")], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ location: "USA", condition: "pre-owned" }));
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const result = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 in the USA, pre-owned");

  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0], /budget/);
  assert.match(result.messages[0], /dial color/);
  assert.doesNotMatch(result.messages[0], /location/, "location was already provided and must not be asked for again");
  assert.doesNotMatch(result.messages[0], /condition/, "condition was already provided and must not be asked for again");
  assert.ok(!result.messages.some((m) => /Potential Match/.test(m)), "must not search until the missing pieces are answered");
});

test("required regression: answering the follow-up merges the missing fields and completes the search — already-known fields are never overwritten", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      fsRow("in-budget", { price: "24500", location: "North America" }),
      fsRow("over-budget", { price: "63000", location: "North America" }),
    ],
    new Date().toISOString()
  );
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ location: "USA", condition: "pre-owned" }); // original message
    return interpreted({ maxPrice: 27000, dialColor: "black" }); // the follow-up reply
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 in the USA, pre-owned");
  const result = await handleIncomingMessage(TEST_PHONE, "27k, black dial");

  const matchCard = result.messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the search must run once the follow-up is answered");
  assert.ok(!result.messages.some((m) => /over-budget|63,?000/.test(m)), "the budget from the follow-up reply must still be enforced");
});

test("only one follow-up round is ever asked — a still-incomplete reply proceeds with whatever is known rather than asking again", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ location: "USA", condition: "pre-owned" });
    return interpreted(); // the follow-up reply itself answers nothing usable
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 in the USA, pre-owned");
  const result = await handleIncomingMessage(TEST_PHONE, "not sure, whatever's available");

  assert.ok(
    result.messages.some((m) => /Potential Match/.test(m)),
    "must proceed with the search rather than asking a second follow-up round"
  );
});

test("a fully-specified message never triggers a follow-up at all", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America" })], new Date().toISOString());
  t.mock.method(
    queryInterpreterModule,
    "interpretQuery",
    async () => interpreted({ maxPrice: 27000, location: "USA", dialColor: "black", condition: "pre-owned" })
  );
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const result = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial, pre-owned, USA");
  assert.ok(result.messages.some((m) => /Potential Match/.test(m)), "a complete message must search immediately");
});
