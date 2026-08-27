import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpretQuery } = require("./queryInterpreter") as typeof import("./queryInterpreter");

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
    hardRequirements: ["reference 116500", "under $25,000"],
    preferences: ["black dial"],
  }));
  const result = await interpretQuery("I need a black Daytona 116500 under 25k in the US");
  assert.equal(result!.action, "buy");
  assert.equal(result!.referenceFamily, "116500");
  assert.equal(result!.maxPrice, 25000);
});

test("required regression: interpretQuery rejects a response with an invalid/missing action rather than trusting it", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "not-a-real-action", brand: null, referenceFamily: null }));
  const result = await interpretQuery("something ambiguous");
  assert.equal(result, null);
});
