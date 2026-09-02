import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isChatIdAllowed } = require("./config") as typeof import("./config");

test("empty allowlist (the default) allows no group", () => {
  assert.equal(isChatIdAllowed("group-1", []), false);
  assert.equal(isChatIdAllowed("anything", []), false);
});

test("one explicitly allowed group is allowed; any other group is not", () => {
  assert.equal(isChatIdAllowed("group-1", ["group-1"]), true);
  assert.equal(isChatIdAllowed("group-2", ["group-1"]), false);
});

test("a disallowed group stays disallowed even alongside other allowed groups", () => {
  assert.equal(isChatIdAllowed("group-3", ["group-1", "group-2"]), false);
});

test("'*' explicitly enables every group", () => {
  assert.equal(isChatIdAllowed("group-1", ["*"]), true);
  assert.equal(isChatIdAllowed("any-random-group-id", ["*"]), true);
});

test("'*' alongside specific ids still enables every group", () => {
  assert.equal(isChatIdAllowed("group-99", ["group-1", "*"]), true);
});
