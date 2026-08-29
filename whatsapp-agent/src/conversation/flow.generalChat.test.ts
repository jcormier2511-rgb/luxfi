import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Fi Concierge Stage 3: genuine small talk / questions (no item request, no pending decision)
// get an AI-generated reply instead of the canned "Try 'buy: ...'" fallback — only for the AI
// matching test phone, and this is pure text generation with no state mutation whatsoever.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-chat-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15550005555";
const OTHER_PHONE = "15559996666";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatReplyModule = require("../ai/chatReply") as typeof import("../ai/chatReply");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("required regression: genuine small talk on the AI test phone gets an AI-generated reply instead of the canned fallback", async (t) => {
  resetState(TEST_PHONE);
  t.mock.method(chatReplyModule, "generateGeneralChatReply", async () => "Doing well, thanks! Looking for anything in particular today?");

  await handleIncomingMessage(TEST_PHONE, "hi"); // consumes the "new contact" intro
  const result = await handleIncomingMessage(TEST_PHONE, "how's it going");
  assert.ok(
    result.messages.includes("Doing well, thanks! Looking for anything in particular today?"),
    "the AI-generated reply must be used verbatim"
  );
  assert.ok(!result.messages.some((m) => m.includes('Try "buy:')), "the canned fallback must not also be sent");
});

test("required regression: when AI is unavailable, the test phone still falls back to the canned reply", async (t) => {
  resetState(TEST_PHONE);
  t.mock.method(chatReplyModule, "generateGeneralChatReply", async () => null);

  await handleIncomingMessage(TEST_PHONE, "hi");
  const result = await handleIncomingMessage(TEST_PHONE, "how's it going");
  assert.ok(result.messages.some((m) => m.includes('Try "buy:')), "an AI failure must never leave the user with no reply at all");
});

test("general chat uses natural language for a non-test phone when AI is enabled", async (t) => {
  resetState(OTHER_PHONE);
  const spy = t.mock.method(chatReplyModule, "generateGeneralChatReply", async () => "Here’s a quick summary of your open matches.");

  await handleIncomingMessage(OTHER_PHONE, "hi");
  const result = await handleIncomingMessage(OTHER_PHONE, "listing summary");
  assert.deepEqual(result.messages, ["Here’s a quick summary of your open matches."]);
  assert.equal(spy.mock.callCount(), 1);
});

test("START clears conversational work and never repeats the approve/pass dead end", async () => {
  resetState(TEST_PHONE);
  await handleIncomingMessage(TEST_PHONE, "hi");
  const result = await handleIncomingMessage(TEST_PHONE, "start");
  assert.equal(result.state.pendingMatches, undefined);
  assert.equal(result.state.pendingPreferenceCollection, undefined);
  assert.equal(result.state.pendingNaturalFollowUp, undefined);
  assert.match(result.messages[0], /tell me naturally/i);
  assert.doesNotMatch(result.messages[0], /approve|pass/i);
});
