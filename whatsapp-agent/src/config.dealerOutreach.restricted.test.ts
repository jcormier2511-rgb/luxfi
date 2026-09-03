import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.RESTRICT_OUTBOUND_TO = "13055550000";
delete process.env.SUPPRESS_DEALER_OUTREACH;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isDealerOutreachSuppressed } = require("./config") as typeof import("./config");

/**
 * The default that matters. Restricting outbound means "I am testing against production data",
 * and nobody sets it intending to still claim real dealers' opportunities and bump their
 * counters — but that is exactly what redirecting alone leaves happening.
 */
test("restricting outbound suppresses dealer outreach without any second flag", () => {
  assert.equal(isDealerOutreachSuppressed(), true);
});
