import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.RESTRICT_OUTBOUND_TO = "13055550000";
process.env.SUPPRESS_DEALER_OUTREACH = "false";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isDealerOutreachSuppressed } = require("./config") as typeof import("./config");

test("an explicit false opts back in, for deliberately exercising the outreach path", () => {
  assert.equal(isDealerOutreachSuppressed(), false);
});
