import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Deliberately NOT setting ANTHROPIC_API_KEY here — this file tests the "no key configured"
// path, which must never attempt a real network call. A separate process (this test file
// running standalone) is what makes it safe to rely on the key being unset regardless of
// what other test files or the real environment configure.
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callAiJson } = require("./client") as typeof import("./client");

test("callAiJson returns null and never touches the network when no API key is configured", async (t) => {
  const spy = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must never call fetch without an API key");
  });
  const result = await callAiJson({ system: "sys", user: "hello" });
  assert.equal(result, null);
  assert.equal(spy.mock.callCount(), 0);
});
