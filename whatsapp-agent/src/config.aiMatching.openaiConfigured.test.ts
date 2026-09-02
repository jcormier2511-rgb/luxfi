import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.AI_MATCHING_PROVIDER = "openai";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AI_MATCHING_OPENAI_MODEL = "gpt-test-model";
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("with the openai provider selected and its own key+model set, the test phone is enabled even with no Anthropic key at all", () => {
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), true);
  assert.equal(isAiMatchingEnabledForPhone("15559998888"), false);
});
