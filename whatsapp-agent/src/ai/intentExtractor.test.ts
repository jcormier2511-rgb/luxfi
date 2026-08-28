import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractIntent, isConfidentIntent } = require("./intentExtractor") as typeof import("./intentExtractor");

function aiResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: "buy",
    brand: null,
    model: null,
    reference: null,
    dial: null,
    condition: null,
    year: null,
    boxPapers: null,
    priceMin: null,
    priceMax: null,
    currency: "USD",
    location: null,
    searchText: null,
    confidence: 0.9,
    ...overrides,
  };
}

test("extractIntent returns null for empty text without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.equal(await extractIntent(""), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("extractIntent returns null when the AI call fails, so the caller falls back to the legacy parser", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  assert.equal(await extractIntent("I want to buy a Patek 5712"), null);
});

test("required: 'I want to buy a Patek 5712' extracts brand/reference/searchText correctly", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", brand: "Patek", reference: "5712" })
  );
  const result = await extractIntent("I want to buy a Patek 5712");
  assert.equal(result!.intent.intent, "buy");
  assert.equal(result!.intent.brand, "Patek Philippe");
  assert.equal(result!.intent.reference, "5712");
  assert.equal(result!.intent.searchText, "Patek Philippe 5712");
});

test("required: 'want to buy a patek 5712G' (no leading 'I') extracts the same way", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", brand: "patek", reference: "5712G" })
  );
  const result = await extractIntent("want to buy a patek 5712G");
  assert.equal(result!.intent.brand, "Patek Philippe");
  assert.equal(result!.intent.reference, "5712G");
  assert.equal(result!.intent.searchText, "Patek Philippe 5712G");
});

test("required: 'I want to sell a Patek 5712' extracts intent=sell", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "sell", brand: "Patek Philippe", reference: "5712" })
  );
  const result = await extractIntent("I want to sell a Patek 5712");
  assert.equal(result!.intent.intent, "sell");
  assert.equal(result!.intent.searchText, "Patek Philippe 5712");
});

test("required: 'Looking for a black Daytona under 25k in the US' extracts brand/model/dial/price/location", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({
      intent: "buy",
      brand: "Rolex",
      model: "Daytona",
      dial: "black",
      priceMax: 25000,
      currency: "USD",
      location: "US",
    })
  );
  const result = await extractIntent("Looking for a black Daytona under 25k in the US");
  assert.equal(result!.intent.brand, "Rolex");
  assert.equal(result!.intent.model, "Daytona");
  assert.equal(result!.intent.dial, "black");
  assert.equal(result!.intent.priceMax, 25000);
  assert.equal(result!.intent.location, "US");
  assert.equal(result!.priceUnreliable, false);
});

test("required: a reference number like 5712G is never mistaken for a price, even if the model hallucinates one", async (t) => {
  // The model claims priceMin=2 (the exact reported "$2" bug pattern) even though the raw text
  // has no currency-adjacent number at all -- the deterministic backstop must reject it.
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", reference: "5712G", priceMin: 2 }));
  const result = await extractIntent("want to buy a patek 5712G");
  assert.notEqual(result!.intent.priceMin, 2);
  assert.equal(result!.intent.priceMin, null);
  assert.equal(result!.priceUnreliable, true, "an unverifiable claimed price must be flagged, not silently trusted");
});

test("a year like 2024 is never mistaken for a price", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", year: 2024, priceMax: 2024 }));
  const result = await extractIntent("looking for a 2024 Daytona");
  assert.equal(result!.intent.year, 2024);
  assert.equal(result!.intent.priceMax, null);
  assert.equal(result!.priceUnreliable, true);
});

test("a claimed price that IS verifiable against the raw text's own currency-adjacent number is trusted", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 25000 }));
  const result = await extractIntent("buy: Daytona under $25,000");
  assert.equal(result!.intent.priceMax, 25000);
  assert.equal(result!.priceUnreliable, false);
});

test("105.000 USD in the raw text normalizes to 105000, not 105 or a hallucinated value", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 105000 }));
  const result = await extractIntent("Patek 5712G FullSet 2024 105.000 USD");
  assert.equal(result!.intent.priceMax, 105000);
  assert.equal(result!.priceUnreliable, false);
});

test("required: 105,000 USD in the raw text is trusted the same way as 105.000 USD", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 105000 }));
  const result = await extractIntent("Patek 5712G 105,000 USD firm");
  assert.equal(result!.intent.priceMax, 105000);
  assert.equal(result!.priceUnreliable, false);
});

test("an 18k gold mention is never mistaken for an $18,000 price, even in the buyer's own message", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 18000 }));
  const result = await extractIntent("looking for an 18k gold Datejust");
  assert.equal(result!.intent.priceMax, null);
  assert.equal(result!.priceUnreliable, true);
});

test("euro and pound symbols are recognized as price markers", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 30000, currency: "EUR" }));
  const eur = await extractIntent("buy: Daytona under €30,000");
  assert.equal(eur!.intent.priceMax, 30000);
  assert.equal(eur!.priceUnreliable, false);

  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", priceMax: 20000, currency: "GBP" }));
  const gbp = await extractIntent("buy: Daytona under £20,000");
  assert.equal(gbp!.intent.priceMax, 20000);
  assert.equal(gbp!.priceUnreliable, false);
});

test("the primary intent verifier retains every supported non-USD currency", async (t) => {
  let current = { amount: 0, currency: "USD" };
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", priceMax: current.amount, currency: current.currency })
  );

  const cases = [
    ["WTB Patek 5712G under HK$900,000", 900000, "HKD"],
    ["WTB Patek 5712G under S$110,000", 110000, "SGD"],
    ["WTB Patek 5712G under C$100,000", 100000, "CAD"],
    ["WTB Patek 5712G under A$100,000", 100000, "AUD"],
    ["WTB Patek 5712G under AED 400,000", 400000, "AED"],
    ["WTB Patek 5712G under CHF 95,000", 95000, "CHF"],
    ["WTB Patek 5712G under ¥15,000,000", 15000000, "JPY"],
    ["WTB Patek 5712G under CN¥700,000", 700000, "CNY"],
    ["WTB Patek 5712G under RMB 700,000", 700000, "CNY"],
  ] as const;

  for (const [text, amount, currency] of cases) {
    current = { amount, currency };
    const result = await extractIntent(text);
    assert.equal(result!.intent.priceMax, amount, text);
    assert.equal(result!.intent.currency, currency, text);
    assert.equal(result!.priceUnreliable, false, text);
  }
});

test("the primary intent verifier corrects an AI-mislabeled HKD budget", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", priceMax: 900000, currency: "USD" })
  );
  const result = await extractIntent("WTB Patek 5712G under HK$900,000 — USD wire accepted");
  assert.equal(result!.intent.priceMax, 900000);
  assert.equal(result!.intent.currency, "HKD");
  assert.equal(result!.priceUnreliable, false);
});

test("the primary intent verifier preserves both endpoints of a same-currency range", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", priceMin: 80000, priceMax: 100000, currency: "USD" })
  );
  const result = await extractIntent("WTB Patek 5712G budget $80k-$100k");
  assert.equal(result!.intent.priceMin, 80000);
  assert.equal(result!.intent.priceMax, 100000);
  assert.equal(result!.intent.currency, "USD");
  assert.equal(result!.priceUnreliable, false);
});

test("the primary intent verifier applies a suffix currency to the full range", async (t) => {
  t.mock.method(client, "callAiJson", async () =>
    aiResult({ intent: "buy", priceMin: 800000, priceMax: 900000, currency: "USD" })
  );
  const result = await extractIntent("WTB Patek 5712G budget 800k-900k HKD");
  assert.equal(result!.intent.priceMin, 800000);
  assert.equal(result!.intent.priceMax, 900000);
  assert.equal(result!.intent.currency, "HKD");
  assert.equal(result!.priceUnreliable, false);
});

test("an invalid/unrecognized intent value from the model is rejected rather than trusted", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "not-a-real-intent" }));
  assert.equal(await extractIntent("something ambiguous"), null);
});

test("isConfidentIntent rejects a low-confidence or 'unknown' result", async (t) => {
  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", confidence: 0.2 }));
  const low = await extractIntent("mumble mumble");
  assert.equal(isConfidentIntent(low!), false);

  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "unknown", confidence: 0.9 }));
  const unknown = await extractIntent("mumble mumble");
  assert.equal(isConfidentIntent(unknown!), false);

  t.mock.method(client, "callAiJson", async () => aiResult({ intent: "buy", confidence: 0.9 }));
  const high = await extractIntent("buy a Daytona");
  assert.equal(isConfidentIntent(high!), true);
});
