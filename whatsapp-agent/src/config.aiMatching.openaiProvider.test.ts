import { test } from "node:test";
import assert from "node:assert/strict";

// Provider set to openai, flag on, test phone set — but the ANTHROPIC key (irrelevant to this
// provider) is what's configured, not the OpenAI credentials. Proves isAiMatchingEnabledForPhone
// checks credentials for whichever provider is actually selected, not just "some key exists."
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.AI_MATCHING_PROVIDER = "openai";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";
process.env.ANTHROPIC_API_KEY = "irrelevant-for-openai";
delete process.env.OPENAI_API_KEY;
delete process.env.AI_MATCHING_OPENAI_MODEL;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config, isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("AI_MATCHING_PROVIDER=openai is read into config.aiMatching.provider", () => {
  assert.equal(config.aiMatching.provider, "openai");
});

test("required regression: an Anthropic key alone is not enough when the provider is openai — OpenAI's own key+model are required", () => {
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), false);
});
