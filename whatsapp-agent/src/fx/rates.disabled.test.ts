import { test } from "node:test";
import assert from "node:assert/strict";

// OPEN_EXCHANGE_RATES_APP_ID deliberately left UNSET — proves the fx module stays inert (never
// calls fetch at all) rather than making a doomed network request with no credentials.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.OPEN_EXCHANGE_RATES_APP_ID;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getRates } = require("./rates") as typeof import("./rates");

test("required regression: getRates never calls fetch and returns null when no app id is configured", async (t) => {
  const spy = t.mock.method(global, "fetch", async () => {
    throw new Error("must never call fetch with no OPEN_EXCHANGE_RATES_APP_ID configured");
  });
  const result = await getRates();
  assert.equal(result, null);
  assert.equal(spy.mock.callCount(), 0);
});
