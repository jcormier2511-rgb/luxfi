import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateGeneralChatReply } = require("./chatReply") as typeof import("./chatReply");

test("generateGeneralChatReply returns null for empty text without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.equal(await generateGeneralChatReply(""), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("generateGeneralChatReply returns null when the AI call fails, so the caller falls back to the canned reply", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  assert.equal(await generateGeneralChatReply("hey how's it going"), null);
});

test("required regression: generateGeneralChatReply returns the model's reply text", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ reply: "Doing great, thanks for asking! Anything you're hunting for today?" }));
  const result = await generateGeneralChatReply("hey how's it going");
  assert.equal(result, "Doing great, thanks for asking! Anything you're hunting for today?");
});

test("generateGeneralChatReply returns null for an empty or missing reply field rather than an empty string", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ reply: "   " }));
  assert.equal(await generateGeneralChatReply("hi"), null);
});

test("required regression: a nonzero pending-match count is passed through as context to the model", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async (req: { user: string }) => {
    assert.match(req.user, /2 match\(es\)/, "the pending match count must be included in what the model sees");
    return { reply: "Hey! You've still got a couple matches waiting on your reply above." };
  });
  const result = await generateGeneralChatReply("hi", 2);
  assert.equal(result, "Hey! You've still got a couple matches waiting on your reply above.");
  assert.equal(spy.mock.callCount(), 1);
});

test("no pending-match context is added when the count is zero", async (t) => {
  t.mock.method(client, "callAiJson", async (req: { user: string }) => {
    assert.equal(req.user, "hi", "the raw message must be sent unmodified when there's nothing pending");
    return { reply: "Hey there!" };
  });
  await generateGeneralChatReply("hi", 0);
});
