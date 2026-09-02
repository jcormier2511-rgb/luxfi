import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Fi Concierge Stage 3 (first slice): a message that already states price/location/dial/
// condition should never be walked through the old one-question-at-a-time interview. Only
// active for the configured AI matching test phone — same gating proven in
// engine.hybridMatching.test.ts — so every other contact's interview stays untouched.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-nl-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15550002222";
const OTHER_PHONE = "15559993333";
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
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "",
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

const PRICE_QUESTION_TEXT = "What's your price range?";

test("required regression: a single free-form message on the AI test phone skips the interview and searches immediately, with the stated budget enforced", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      fsRow("in-budget", {
        brand: "Rolex",
        ref: "116500LN",
        price: "24500",
        condition: "Pre-owned",
        location: "USA",
        description: "Rolex Daytona 116500LN black dial, pre-owned, USA",
      }),
      fsRow("over-budget", {
        brand: "Rolex",
        ref: "116500LN",
        price: "63000",
        location: "USA",
        description: "Rolex Daytona 116500LN, USA",
      }),
    ],
    new Date().toISOString()
  );

  t.mock.method(
    queryInterpreterModule,
    "interpretQuery",
    async () => interpreted({ maxPrice: 27000, location: "USA", dialColor: "black", condition: "pre-owned" })
  );
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) =>
    candidates.map((c) => ({ id: c.id, explanation: "matches request", evidence: "Rolex Daytona 116500LN" }))
  );

  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(TEST_PHONE, "hi"));
  push(await handleIncomingMessage(TEST_PHONE, "looking for a rolex daytona 116500 under 27k, black dial, pre-owned, USA"));

  assert.ok(
    !collected.some((m) => m.includes(PRICE_QUESTION_TEXT)),
    "the interview must never run for the AI test phone when interpretation succeeds"
  );
  const matchCard = collected.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the search must run immediately off the one message");
  assert.match(matchCard!, /in-budget|24500/);
  assert.ok(!collected.some((m) => /over-budget|63,?000/.test(m)), "the $63,000 listing is over the stated $27,000 maximum and must be excluded");
});

test("required regression: when AI interpretation fails, the AI test phone falls back to the ordinary interview rather than skipping the price filter", async (t) => {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { brand: "Rolex", ref: "116500LN", price: "24500" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => null); // simulates an AI outage

  const first = await handleIncomingMessage(TEST_PHONE, "hi");
  const second = await handleIncomingMessage(TEST_PHONE, "buy: Rolex Daytona 116500LN");
  assert.ok(
    [...first.messages, ...second.messages].some((m) => m.includes(PRICE_QUESTION_TEXT)),
    "an AI outage must fall back to the interview, never skip the price question"
  );
});

test("a non-test phone's interview is completely unaffected by this natural-language path", async (t) => {
  resetState(OTHER_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a", { brand: "Rolex", ref: "116500LN", price: "24500" })], new Date().toISOString());
  const spy = t.mock.method(queryInterpreterModule, "interpretQuery", async () => {
    throw new Error("must never be called for a non-test phone");
  });

  const first = await handleIncomingMessage(OTHER_PHONE, "hi");
  const second = await handleIncomingMessage(OTHER_PHONE, "buy: Rolex Daytona 116500LN");
  assert.ok(
    [...first.messages, ...second.messages].some((m) => m.includes(PRICE_QUESTION_TEXT)),
    "a non-test phone must still get the ordinary interview"
  );
  assert.equal(spy.mock.callCount(), 0);
});
