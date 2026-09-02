import { test } from "node:test";
import assert from "node:assert/strict";

// Master flag on, API key configured, AND a specific test phone — all three set before config
// is required, so isAiMatchingEnabledForPhone's real three-condition gate can be exercised.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("required regression: even with the flag on, only the configured test phone is enabled", () => {
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), true);
  assert.equal(isAiMatchingEnabledForPhone("15559998888"), false, "a real user's phone must never get the AI path during a restricted first live test");
});
