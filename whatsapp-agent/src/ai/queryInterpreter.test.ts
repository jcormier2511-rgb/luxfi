import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpretQuery, toSearchPreferences } = require("./queryInterpreter") as typeof import("./queryInterpreter");

test("interpretQuery returns null for empty text without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.equal(await interpretQuery(""), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("interpretQuery returns null when the AI call fails, so the caller falls back to deterministic parsing", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  assert.equal(await interpretQuery("I need a black Daytona 116500 under 25k in the US"), null);
});

test("interpretQuery returns a structured result for a valid buy/sell action", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({
    action: "buy",
    brand: "Rolex",
    referenceFamily: "116500",
    maxPrice: 25000,
    minPrice: null,
    location: "US",
    dialColor: "black",
    condition: "pre-owned",
    hardRequirements: ["reference 116500", "under $25,000"],
    preferences: ["black dial"],
  }));
  const result = await interpretQuery("I need a black Daytona 116500 under 25k in the US");
  assert.equal(result!.action, "buy");
  assert.equal(result!.referenceFamily, "116500");
  assert.equal(result!.maxPrice, 25000);
  assert.equal(result!.dialColor, "black");
  assert.equal(result!.condition, "pre-owned");
});

test("required regression: interpretQuery rejects a response with an invalid/missing action rather than trusting it", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "not-a-real-action", brand: null, referenceFamily: null }));
  const result = await interpretQuery("something ambiguous");
  assert.equal(result, null);
});

test("required regression: one free-form message can stand in for the whole price/location/dial/condition interview", () => {
  const prefs = toSearchPreferences({
    action: "buy",
    brand: "Rolex",
    referenceFamily: "116500",
    maxPrice: 27000,
    minPrice: null,
    location: "USA",
    dialColor: "black",
    condition: "pre-owned",
    hardRequirements: [],
    preferences: [],
  });
  assert.deepEqual(prefs, { priceMax: 27000, location: "USA", dialColor: "black", condition: "pre-owned" });
});

test("toSearchPreferences leaves a field unset (never guesses) when the model didn't find it", () => {
  const prefs = toSearchPreferences({
    action: "buy",
    brand: null,
    referenceFamily: null,
    maxPrice: null,
    minPrice: null,
    location: null,
    dialColor: null,
    condition: null,
    hardRequirements: [],
    preferences: [],
  });
  assert.deepEqual(prefs, {});
});
