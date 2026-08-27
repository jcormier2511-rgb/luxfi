import { test } from "node:test";
import assert from "node:assert/strict";

// Flag on and a test phone configured, but ANTHROPIC_API_KEY deliberately left unset —
// the feature must stay inert rather than guessing at credentials.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";
delete process.env.ANTHROPIC_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isAiMatchingEnabledForPhone } = require("./config") as typeof import("./config");

test("required regression: the flag and test phone alone are not enough — a missing API key keeps it off even for the test phone", () => {
  assert.equal(isAiMatchingEnabledForPhone("15550001111"), false);
});
