import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpretQuery, toSearchPreferences, extractConfirmedNaturalLanguageIntent } = require("./queryInterpreter") as typeof import("./queryInterpreter");

test("confirmed natural-language fields preserve a comma-formatted Patek budget", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("I’m looking for a Patek 5712G under $110,000."), {
    intent: "buy",
    brand: "Patek Philippe",
    reference: "5712G",
    priceMin: null,
    priceMax: 110000,
    currency: "USD",
  });
});

test("explicit price text corrects an AI response that truncated $110,000 to $110", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({
    action: "buy", brand: "Patek", referenceFamily: "5712", maxPrice: 110, minPrice: null,
    location: null, dialColor: null, condition: null, hardRequirements: [], preferences: [],
  }));
  const result = await interpretQuery("I’m looking for a Patek 5712G under $110,000.");
  assert.equal(result?.brand, "Patek Philippe");
  assert.equal(result?.referenceFamily, "5712G");
  assert.equal(result?.maxPrice, 110000);
});

test("confirmed buyer budgets retain their stated non-USD currency", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G under HKD 900,000"), {
    intent: "buy", brand: "Patek Philippe", reference: "5712G", priceMin: null, priceMax: 900000, currency: "HKD",
  });
});

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

test("reference-only requests never turn the watch reference into a price ceiling", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G"), {
    intent: "buy", brand: "Patek Philippe", reference: "5712G", priceMin: null, priceMax: null, currency: null,
  });
});

test("a shorthand budget is never promoted to the watch reference", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek Nautilus under $110k"), {
    intent: "buy", brand: "Patek Philippe", reference: null, priceMin: null, priceMax: 110000, currency: "USD",
  });
});

test("reference and shorthand price remain distinct when both are present", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("I need a Daytona 116500 under 25k"), {
    intent: "buy", brand: null, reference: "116500", priceMin: null, priceMax: 25000, currency: "USD",
  });
});

test("confirmed SGD budgets retain their currency and maximum", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G under SGD 110,000"), {
    intent: "buy", brand: "Patek Philippe", reference: "5712G", priceMin: null, priceMax: 110000, currency: "SGD",
  });
});

test("explicit maximum and budget phrases remain exact ceilings", () => {
  for (const text of ["WTB Patek 5712G maximum 100k", "WTB Patek 5712G budget of $100,000"]) {
    assert.deepEqual(extractConfirmedNaturalLanguageIntent(text), {
      intent: "buy", brand: "Patek Philippe", reference: "5712G", priceMin: null, priceMax: 100000, currency: "USD",
    });
  }
});

test("interpretQuery corrects an AI-inflated maximum to the explicit ceiling", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({
    action: "buy", brand: "Patek", referenceFamily: "5712", maxPrice: 115000, minPrice: null,
    location: null, dialColor: null, condition: null, hardRequirements: [], preferences: [],
  }));
  const result = await interpretQuery("WTB Patek 5712G maximum 100k");
  assert.equal(result!.maxPrice, 100000);
});

test("a marked price is parsed instead of the earlier watch reference", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G HKD 900,000"), {
    intent: "buy",
    brand: "Patek Philippe",
    reference: "5712G",
    priceMin: Math.round(900000 * 0.85),
    priceMax: Math.round(900000 * 1.15),
    currency: "HKD",
  });
});

test("explicit buyer language wins when 'for sale' only describes the desired watch", () => {
  assert.equal(
    extractConfirmedNaturalLanguageIntent("Looking to buy a Patek 5712G that's for sale").intent,
    "buy"
  );
});

test("a budget range preserves both endpoints instead of truncating to the first", () => {
  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G budget $80k-$100k"), {
    intent: "buy",
    brand: "Patek Philippe",
    reference: "5712G",
    priceMin: 80000,
    priceMax: 100000,
    currency: "USD",
  });
});

test("an explicit minimum remains a floor without an invented ceiling", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({
    action: "buy", brand: "Patek", referenceFamily: "5712", maxPrice: 115000, minPrice: null,
    location: null, dialColor: null, condition: null, hardRequirements: [], preferences: [],
  }));

  assert.deepEqual(extractConfirmedNaturalLanguageIntent("WTB Patek 5712G minimum HKD 100k"), {
    intent: "buy",
    brand: "Patek Philippe",
    reference: "5712G",
    priceMin: 100000,
    priceMax: null,
    currency: "HKD",
  });

  const result = await interpretQuery("WTB Patek 5712G minimum HKD 100k");
  assert.equal(result!.minPrice, 100000);
  assert.equal(result!.maxPrice, null);
  assert.equal(result!.currency, "HKD");
});
