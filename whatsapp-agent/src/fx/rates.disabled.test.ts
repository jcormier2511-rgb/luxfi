import { test } from "node:test";
import assert from "node:assert/strict";

// OPEN_EXCHANGE_RATES_APP_ID deliberately left UNSET — proves the fx module stays inert (never
// calls fetch at all) rather than making a doomed network request with no credentials.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.OPEN_EXCHANGE_RATES_APP_ID;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getRates, getFxHealth } = require("./rates") as typeof import("./rates");

test("required regression: getRates never calls fetch and returns null when no app id is configured", async (t) => {
  const spy = t.mock.method(global, "fetch", async () => {
    throw new Error("must never call fetch with no OPEN_EXCHANGE_RATES_APP_ID configured");
  });
  const result = await getRates();
  assert.equal(result, null);
  assert.equal(spy.mock.callCount(), 0);
});

test("required regression: getFxHealth reports configured:false (not a network error) when no app id is set — this exact gap previously had no admin-visible signal at all while every non-USD conversion silently failed", async (t) => {
  const spy = t.mock.method(global, "fetch", async () => {
    throw new Error("must never call fetch with no OPEN_EXCHANGE_RATES_APP_ID configured");
  });
  const health = await getFxHealth();
  assert.deepEqual(health, {
    configured: false,
    hasCachedRates: false,
    ratesAgeHours: null,
    stale: true,
    baseCurrency: null,
    ratesCount: 0,
  });
  assert.equal(spy.mock.callCount(), 0, "an unconfigured app id must never attempt a live fetch");
});
