import { test } from "node:test";
import assert from "node:assert/strict";

// ENABLE_AI_MATCHING, ANTHROPIC_API_KEY, and AI_MATCHING_TEST_PHONE all deliberately left
// UNSET — proving the documented default keeps the hybrid path inert for everyone.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config, isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("ENABLE_AI_MATCHING defaults to disabled, with no test phone or API key configured", () => {
  assert.equal(config.aiMatching.enabled, false);
  assert.deepEqual(config.aiMatching.testPhones, []);
  assert.equal(config.aiMatching.apiKey, "");
});

test("isAiMatchingEnabledForPhone is false for any phone by default", () => {
  assert.equal(isAiMatchingEnabledForPhone("15551234567"), false);
  assert.equal(isAiMatchingEnabledForPhone(""), false);
});
