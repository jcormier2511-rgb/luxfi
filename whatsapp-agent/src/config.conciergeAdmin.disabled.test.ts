import { test } from "node:test";
import assert from "node:assert/strict";

// WATCHFACTS_ADMIN_PHONES deliberately left UNSET — proves no phone is an admin by default.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.WATCHFACTS_ADMIN_PHONES;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isConciergeAdminPhone } = require("./config") as typeof import("./config");

test("no phone is a concierge admin by default", () => {
  assert.equal(isConciergeAdminPhone("15551234567"), false);
  assert.equal(isConciergeAdminPhone(""), false);
});
