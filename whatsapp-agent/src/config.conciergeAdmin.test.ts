import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WATCHFACTS_ADMIN_PHONES = "15551234567, 15559876543";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isConciergeAdminPhone } = require("./config") as typeof import("./config");

test("required regression: only explicitly configured admin phones pass, everyone else is denied", () => {
  assert.equal(isConciergeAdminPhone("15551234567"), true);
  assert.equal(isConciergeAdminPhone("15559876543"), true, "whitespace around a comma-separated entry must be trimmed");
  assert.equal(isConciergeAdminPhone("15550001111"), false);
  assert.equal(isConciergeAdminPhone(""), false);
});
