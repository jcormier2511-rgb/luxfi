import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPEN_EXCHANGE_RATES_APP_ID = "test-app-id";
process.env.FX_MAX_STALENESS_HOURS = "24";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFxHealth, _setRatesForTests, _resetRatesForTests } = require("./rates") as typeof import("./rates");

beforeEach(() => {
  _resetRatesForTests();
});

test("required regression: getFxHealth reports a fresh cached table as healthy, with no live fetch (a burst of admin-page loads must never re-hit the provider)", async (t) => {
  const spy = t.mock.method(global, "fetch", async () => {
    throw new Error("must not fetch while a fresh table is already cached");
  });
  _setRatesForTests({ base: "USD", rates: { HKD: 7.8, EUR: 0.92 }, fetchedAt: new Date() });
  const health = await getFxHealth();
  assert.equal(health.configured, true);
  assert.equal(health.hasCachedRates, true);
  assert.equal(health.stale, false);
  assert.equal(health.baseCurrency, "USD");
  assert.equal(health.ratesCount, 2);
  assert.ok(health.ratesAgeHours !== null && health.ratesAgeHours < 1);
  assert.equal(spy.mock.callCount(), 0);
});

test("required regression: getFxHealth reports stale:true once the cached table is older than FX_MAX_STALENESS_HOURS -- this is the exact state that let non-USD listings silently drop out of Market Pulse/Guide for weeks with no visible signal", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503, text: async () => "unavailable" }) as Response);
  const staleFetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h old
  _setRatesForTests({ base: "USD", rates: { HKD: 7.8 }, fetchedAt: staleFetchedAt });
  const health = await getFxHealth();
  assert.equal(health.configured, true);
  assert.equal(health.stale, true, "a 25h-old table past the 24h staleness ceiling must be flagged, not reported as healthy");
});
