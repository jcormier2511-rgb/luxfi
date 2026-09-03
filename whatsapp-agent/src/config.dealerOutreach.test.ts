import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.RESTRICT_OUTBOUND_TO;
delete process.env.SUPPRESS_DEALER_OUTREACH;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isDealerOutreachSuppressed } = require("./config") as typeof import("./config");

test("normal production posture: dealers are notified", () => {
  assert.equal(isDealerOutreachSuppressed(), false);
});
