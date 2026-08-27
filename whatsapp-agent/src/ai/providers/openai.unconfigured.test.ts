import { test } from "node:test";
import assert from "node:assert/strict";

// Deliberately leaving OPENAI_API_KEY and AI_MATCHING_OPENAI_MODEL both unset — separate file
// so a real value set elsewhere (openai.test.ts) can never leak into this one.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
delete process.env.OPENAI_API_KEY;
delete process.env.AI_MATCHING_OPENAI_MODEL;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callOpenAiJson } = require("./openai") as typeof import("./openai");

test("required regression: callOpenAiJson never touches the network without BOTH an API key and a configured model", async (t) => {
  const spy = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must never call fetch when unconfigured");
  });
  const result = await callOpenAiJson({ system: "sys", user: "hello" });
  assert.equal(result, null);
  assert.equal(spy.mock.callCount(), 0);
});
