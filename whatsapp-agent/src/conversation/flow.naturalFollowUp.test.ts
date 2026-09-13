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

test('required regression: "skip" answers a still-missing field the same way a bare "any" does, instead of being re-asked forever -- live-reported bug: replying "skip" to "what\'s your dial color?" got the identical question back with no way to move on', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ maxPrice: 27000, location: "USA", condition: "pre-owned" }); // dial color still missing
    return interpreted(); // "skip" itself answers nothing usable to the AI interpreter
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const asked = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k in the USA, pre-owned");
  assert.ok(asked.state.pendingNaturalFollowUp, "precondition: dial color is the one still-missing field");

  const result = await handleIncomingMessage(TEST_PHONE, "skip");
  assert.equal(result.state.pendingNaturalFollowUp, undefined, '"skip" must resolve the follow-up, not repeat the question');
  assert.ok(result.messages.some((m) => /Potential Match/.test(m)), "the search must run once \"skip\" answers the last missing field");
  assert.ok(!result.messages.some((m) => /dial color/i.test(m)), 'must never re-ask "what\'s your dial color?" after "skip"');
});

test("an incomplete follow-up remains pending and does not search with missing required fields", async (t) => {
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

  assert.ok(result.state.pendingNaturalFollowUp, "missing fields keep the request in draft state");
  assert.ok(result.messages.some((m) => /budget|dial color/i.test(m)), "Fi asks only for the still-missing information");
  assert.ok(!result.messages.some((m) => /Potential Match/.test(m)), "an incomplete request must not search");
});

/**
 * Real reported bug: "Just one more thing — what's your condition?" kept re-asking the identical
 * question after a bare, natural one-word reply ("New") -- the AI interpreter is tuned for full
 * sentences stating a whole request, not a bare word with nothing else, and returned nothing
 * usable for it. A deterministic fallback (the same slot extraction the sell/buy intake steps
 * already use) now also tries the reply, so a bare answer to a single missing field still fills
 * it in even when the AI call itself extracts nothing.
 */
test('required regression: a bare one-word follow-up answer ("New") is still recognized as the condition, even when the AI interpreter extracts nothing from it', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America", condition: "New" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ maxPrice: 27000, location: "USA", dialColor: "black" }); // condition alone missing
    return interpreted(); // the AI extracts nothing usable from the bare follow-up reply itself
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const asked = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial, USA");
  assert.match(asked.messages.join("\n"), /what's your condition\?/i, "precondition: condition is the only field left missing");

  const result = await handleIncomingMessage(TEST_PHONE, "New");
  assert.doesNotMatch(result.messages.join("\n"), /what's your condition\?/i, "must not ask the identical question again");
  const matchCard = result.messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the deterministic fallback filled the last missing field, so the search must run");
});

test('required regression: a bare one-word follow-up answer ("USA") is still recognized as the location, even when the AI interpreter extracts nothing from it -- live-reported bug: Fi kept re-asking "what\'s your location?" forever even after the customer answered it', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America", condition: "New" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ maxPrice: 27000, dialColor: "black", condition: "New" }); // location alone missing
    return interpreted(); // the AI extracts nothing usable from the bare follow-up reply itself
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const asked = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial, New");
  assert.match(asked.messages.join("\n"), /what's your location\?/i, "precondition: location is the only field left missing");

  const result = await handleIncomingMessage(TEST_PHONE, "USA");
  assert.doesNotMatch(result.messages.join("\n"), /what's your location\?/i, "must not ask the identical question again");
  const matchCard = result.messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the deterministic fallback filled the last missing field, so the search must run");
});

test('required regression: a bare numeric follow-up answer ("200k") is still recognized as the budget, even when the AI interpreter extracts nothing from it -- live-reported bug: Fi kept re-asking the identical "what\'s your budget, dial color and condition?" question forever, even after the customer answered budget, because the deterministic backstop covered location/dial/condition but never price', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America", condition: "New" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ location: "USA", dialColor: "black", condition: "New" }); // budget alone missing
    return interpreted(); // the AI extracts nothing usable from the bare follow-up reply itself
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const asked = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500, black dial, New, USA");
  assert.match(asked.messages.join("\n"), /what's your budget\?/i, "precondition: budget is the only field left missing");

  const result = await handleIncomingMessage(TEST_PHONE, "200k");
  assert.doesNotMatch(result.messages.join("\n"), /what's your budget\?/i, "must not ask the identical question again");
  const matchCard = result.messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the deterministic fallback filled the last missing field, so the search must run");
});

test('required regression: a bare word that already answers CONDITION must never also be misread as the location, when both are still missing', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { location: "North America", condition: "pre-owned" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("looking for")) return interpreted({ maxPrice: 27000, dialColor: "black" }); // location AND condition missing
    return interpreted();
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const asked = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial");
  assert.match(asked.messages.join("\n"), /location/i);
  assert.match(asked.messages.join("\n"), /condition/i);

  const result = await handleIncomingMessage(TEST_PHONE, "used");
  assert.match(
    result.messages.join("\n"),
    /what's your location\?/i,
    "condition is now filled, but location is still genuinely missing and must still be asked for -- 'used' must not have been misapplied to it"
  );
});

test('required regression: a genuinely fresh new request sent while an old natural-language follow-up is still open starts a NEW search, never silently answers the stale one -- live-reported bug: replied about reference "5711" mid-conversation while an older "116500" follow-up was still open, and the search that ran was still for "116500"', async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  // Deliberately only a Patek 5711 listing exists -- if the bug regresses and the search still
  // silently runs against the STALE "116500" request instead of the fresh "5711" one, there is
  // nothing for it to match, and it would report no live matches instead of a real card.
  await inventoryDb.upsertListings(
    [fsRow("new-request", { brand: "Patek Philippe", ref: "5711", item: "item-new-request", description: "Patek Philippe 5711" })],
    new Date().toISOString()
  );
  t.mock.method(queryInterpreterModule, "interpretQuery", async (text: string) => {
    if (text.includes("116500")) return interpreted({ maxPrice: 27000, dialColor: "black" }); // location AND condition still missing -- leaves a follow-up open
    if (text.includes("5711")) return interpreted({ brand: "Patek Philippe", referenceFamily: "5711", maxPrice: 50000, location: "USA", dialColor: "blue", condition: "New" });
    return interpreted();
  });
  mockAlwaysMatches(t);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const opened = await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial");
  assert.ok(opened.state.pendingNaturalFollowUp, "precondition: a follow-up is left open, still missing location/condition");

  const result = await handleIncomingMessage(TEST_PHONE, "looking for a patek 5711 budget 50k blue dial new in the usa");
  assert.equal(result.state.pendingNaturalFollowUp, undefined, "the stale follow-up must be abandoned, not carried forward");
  assert.match(result.messages.join("\n"), /Potential Match/i, "the NEW request must actually run its own search, not silently answer the stale one");
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
