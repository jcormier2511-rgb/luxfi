import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.WHAPI_TOKEN;

const client = require("./client") as typeof import("./client");

test("checkWhapiHealth reports not-configured, without calling fetch, when WHAPI_TOKEN is unset", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  const result = await client.checkWhapiHealth();
  assert.deepEqual(result, { configured: false, reachable: false, authorized: null, statusText: null, version: null, error: null });
  assert.equal(fetchMock.mock.callCount(), 0, "an unconfigured channel must never make a live call");
});
