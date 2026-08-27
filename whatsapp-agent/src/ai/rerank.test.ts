import { test } from "node:test";
import assert from "node:assert/strict";
import { InventoryListing } from "../types";
import { InterpretedQuery } from "./types";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rerankCandidates } = require("./rerank") as typeof import("./rerank");

function listing(overrides: Partial<InventoryListing> = {}): InventoryListing {
  return {
    id: "a",
    type: "FS",
    category: "watches",
    item: "Rolex Daytona 116500LN",
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "28500",
    location: "Miami",
    contactName: "Seller",
    contactPhone: "123",
    source: "WF",
    rating: "",
    description: "Rolex Daytona 116500LN, box and papers",
    ...overrides,
  };
}

const query: InterpretedQuery = {
  action: "buy",
  brand: "Rolex",
  referenceFamily: "116500",
  maxPrice: null,
  minPrice: null,
  location: null,
  hardRequirements: [],
  preferences: [],
};

test("rerankCandidates returns [] immediately for an empty pool, without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called with an empty pool");
  });
  const result = await rerankCandidates(query, []);
  assert.deepEqual(result, []);
  assert.equal(spy.mock.callCount(), 0);
});

test("rerankCandidates returns null (not []) when the AI call itself fails, so callers fall back instead of showing nothing", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  const result = await rerankCandidates(query, [listing()]);
  assert.equal(result, null);
});

test("rerankCandidates keeps a pick whose evidence is a real substring of that exact candidate's text", async (t) => {
  t.mock.method(client, "callAiJson", async () => [{ id: "a", explanation: "exact reference match", evidence: "116500LN" }]);
  const result = await rerankCandidates(query, [listing()]);
  assert.equal(result!.length, 1);
  assert.equal(result![0].id, "a");
});

test("required regression: a pick referencing an id that isn't in the given candidate pool is dropped, never trusted", async (t) => {
  t.mock.method(client, "callAiJson", async () => [{ id: "invented-id", explanation: "made up", evidence: "anything" }]);
  const result = await rerankCandidates(query, [listing({ id: "a" })]);
  assert.deepEqual(result, [], "an id AI invented that wasn't in the candidate pool must never be trusted");
});

test("required regression: a pick whose evidence isn't actually present in that candidate's text is dropped", async (t) => {
  t.mock.method(client, "callAiJson", async () => [{ id: "a", explanation: "claims a match", evidence: "text that was never in this listing" }]);
  const result = await rerankCandidates(query, [listing({ id: "a" })]);
  assert.deepEqual(result, []);
});

test("a pick whose evidence comes from a DIFFERENT candidate's text is dropped, not attributed to the wrong listing", async (t) => {
  const candidates = [listing({ id: "a", description: "Rolex Daytona 116500LN" }), listing({ id: "b", ref: "5711", description: "Patek Nautilus 5711" })];
  t.mock.method(client, "callAiJson", async () => [{ id: "a", explanation: "cross-contaminated evidence", evidence: "Patek Nautilus 5711" }]);
  const result = await rerankCandidates(query, candidates);
  assert.deepEqual(result, []);
});
