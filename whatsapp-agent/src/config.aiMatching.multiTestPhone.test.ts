import { test } from "node:test";
import assert from "node:assert/strict";

// AI_MATCHING_TEST_PHONE now accepts a comma-separated list, same convention as
// WATCHFACTS_ADMIN_PHONES — set before config is ever required, own file per the codebase's
// established pattern for exercising a flag's env-var-dependent state in isolation.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "15550001111, 13057846663";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config, isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("required regression: AI_MATCHING_TEST_PHONE accepts more than one phone, comma-separated", () => {
  assert.deepEqual(config.aiMatching.testPhones, ["15550001111", "13057846663"]);
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), true);
  assert.equal(isAiMatchingEnabledForPhone("13057846663"), true, "whitespace around a comma-separated entry must be trimmed");
  assert.equal(isAiMatchingEnabledForPhone("15559998888"), false, "a phone not on the list must still be denied");
});
