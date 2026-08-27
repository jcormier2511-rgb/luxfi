import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.AI_MATCHING_PROVIDER = "openai";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const anthropicProvider = require("./providers/anthropic") as typeof import("./providers/anthropic");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const openaiProvider = require("./providers/openai") as typeof import("./providers/openai");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callAiJson } = require("./client") as typeof import("./client");

test("required regression: AI_MATCHING_PROVIDER=openai routes callAiJson to the OpenAI provider, never Anthropic", async (t) => {
  const anthropicSpy = t.mock.method(anthropicProvider, "callAnthropicJson", async () => {
    throw new Error("must never be called when the provider is openai");
  });
  t.mock.method(openaiProvider, "callOpenAiJson", async () => ({ ok: true }));

  const result = await callAiJson({ system: "sys", user: "hello" });
  assert.deepEqual(result, { ok: true });
  assert.equal(anthropicSpy.mock.callCount(), 0);
});
