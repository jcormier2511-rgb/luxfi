import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPEN_EXCHANGE_RATES_APP_ID = "test-app-id";
process.env.FX_MAX_STALENESS_HOURS = "24";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { convertAmount } = require("./convert") as typeof import("./convert");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _setRatesForTests, _resetRatesForTests } = require("./rates") as typeof import("./rates");

const FRESH_RATES = { base: "USD", rates: { HKD: 7.8, EUR: 0.92, GBP: 0.79, JPY: 149.5 }, fetchedAt: new Date() };

beforeEach(() => {
  _resetRatesForTests();
});

test("required regression: converts HKD to USD using the cached rates table", async () => {
  _setRatesForTests(FRESH_RATES);
  // HK$850,000 at 7.8 HKD/USD ≈ $108,974 — matches the spec's example ($109,100 with a
  // slightly different rate is just a different day's rate; the math is amount / (rate/1)).
  const result = await convertAmount(850000, "HKD", "USD");
  assert.ok(result);
  assert.equal(result!.currency, "USD");
  assert.ok(Math.abs(result!.amount - 850000 / 7.8) < 0.01);
  assert.equal(result!.rate, 1 / 7.8);
});

test("required regression: converts EUR to USD", async () => {
  _setRatesForTests(FRESH_RATES);
  const result = await convertAmount(95000, "EUR", "USD");
  assert.ok(result);
  assert.ok(Math.abs(result!.amount - 95000 / 0.92) < 0.01);
});

test("required regression: converts USD to EUR (base currency as the source)", async () => {
  _setRatesForTests(FRESH_RATES);
  const result = await convertAmount(110000, "USD", "EUR");
  assert.ok(result);
  assert.ok(Math.abs(result!.amount - 110000 * 0.92) < 0.01);
  assert.equal(result!.currency, "EUR");
});

test("same-currency conversion is a no-op, rate 1, and never touches the rates table at all", async () => {
  _resetRatesForTests(); // no rates loaded — proves this path doesn't need them
  const result = await convertAmount(50000, "USD", "USD");
  assert.deepEqual(result, { amount: 50000, currency: "USD", rate: 1, source: "openexchangerates", timestamp: result!.timestamp });
});

test("required regression: stale rates (older than FX_MAX_STALENESS_HOURS) never produce a confident conversion", async (t) => {
  // Stale-by-age also means stale-by-refresh-interval, so getRates() will attempt an actual
  // refresh — mocked here to fail (an outage is exactly the realistic reason it'd still be
  // stale), so isRatesStale() still sees the old table and correctly refuses to convert.
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503, text: async () => "unavailable" }) as Response);
  const staleRates = { ...FRESH_RATES, fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }; // 25h old
  _setRatesForTests(staleRates);
  const result = await convertAmount(850000, "HKD", "USD");
  assert.equal(result, null, "a stale rates table must never be used to confidently confirm a converted amount");
});

test("required regression: an unknown/unsupported currency returns null rather than guessing a rate", async () => {
  _setRatesForTests(FRESH_RATES);
  assert.equal(await convertAmount(1000, "XYZ", "USD"), null);
  assert.equal(await convertAmount(1000, "USD", "XYZ"), null);
});

test("required regression: a failed rates fetch (never mocked to succeed) resolves to null, never throws", async (t) => {
  _resetRatesForTests();
  // No rates ever seeded — getRates() will try an actual fetch. Mocked here to fail exactly
  // like a real provider outage would (never a live network call in a test).
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 401, text: async () => "invalid app_id" }) as Response);
  const result = await convertAmount(850000, "HKD", "USD");
  assert.equal(result, null);
});
