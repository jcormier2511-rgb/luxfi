import { test } from "node:test";
import assert from "node:assert/strict";

// AI_MATCHING_TEST_PHONE="*" is the deliberate full-rollout switch -- same wildcard convention
// isChatIdAllowed already uses for allowedChatIds. Own file per the codebase's established
// pattern for exercising a flag's env-var-dependent state in isolation.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config, isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("required regression: AI_MATCHING_TEST_PHONE=* enables AI matching for any phone, not just a listed one", () => {
  assert.deepEqual(config.aiMatching.testPhones, ["*"]);
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), true);
  assert.equal(isAiMatchingEnabledForPhone("13057846663"), true);
  assert.equal(isAiMatchingEnabledForPhone("anything-at-all"), true, "the wildcard must not silently require phone-shaped input");
});

test("required regression: the wildcard still requires the master flag and a configured API key -- it is not an independent bypass", () => {
  const originalEnabled = config.aiMatching.enabled;
  const originalApiKey = config.aiMatching.apiKey;
  try {
    (config.aiMatching as { enabled: boolean }).enabled = false;
    assert.equal(isAiMatchingEnabledForPhone("15550001111"), false, "disabling the master flag must still win over the wildcard");
    (config.aiMatching as { enabled: boolean }).enabled = true;
    (config.aiMatching as { apiKey: string }).apiKey = "";
    assert.equal(isAiMatchingEnabledForPhone("15550001111"), false, "an unset API key must still win over the wildcard");
  } finally {
    (config.aiMatching as { enabled: boolean }).enabled = originalEnabled;
    (config.aiMatching as { apiKey: string }).apiKey = originalApiKey;
  }
});
