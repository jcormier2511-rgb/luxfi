import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpretDecision } = require("./decisionInterpreter") as typeof import("./decisionInterpreter");

test("interpretDecision returns null for empty text without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.equal(await interpretDecision("", 2), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("interpretDecision returns null when there are no matches to decide on, without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called with zero matches shown");
  });
  assert.equal(await interpretDecision("I'll take the first one", 0), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("interpretDecision returns null when the AI call fails, so the caller falls back to the deterministic parser", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  assert.equal(await interpretDecision("I'll take the first one", 2), null);
});

test("required regression: interpretDecision maps natural phrasing to an action and index", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "approve", index: 1 }));
  const result = await interpretDecision("I'll take the first one", 2);
  assert.deepEqual(result, { action: "approve", index: 1 });
});

test("interpretDecision allows a null index for an unspecified match (caller defaults to 1)", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "pass", index: null }));
  const result = await interpretDecision("no thanks", 1);
  assert.deepEqual(result, { action: "pass", index: null });
});

test("required regression: interpretDecision returns action: null for a message that isn't actually a decision", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: null, index: null }));
  const result = await interpretDecision("hey how's it going", 2);
  assert.deepEqual(result, { action: null, index: null });
});

test("required regression: interpretDecision rejects a response with an invalid action rather than trusting it", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "maybe", index: 1 }));
  assert.equal(await interpretDecision("hmm", 2), null);
});
