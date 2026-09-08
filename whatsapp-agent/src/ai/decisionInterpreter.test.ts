import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { interpretDecision, interpretPostingsDecision } = require("./decisionInterpreter") as typeof import("./decisionInterpreter");

const OPTIONS = [
  { matchId: 182, counterpartName: "ABC Watches", brand: "Rolex", model: "Daytona", reference: "116500LN" },
  { matchId: 205, counterpartName: "XYZ Timepieces", brand: "Rolex", model: "Submariner", reference: "126610LN" },
];

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

test("interpretPostingsDecision returns null for empty text without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.equal(await interpretPostingsDecision("", OPTIONS), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("interpretPostingsDecision returns null when there are no pending matches to decide on, without calling AI", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called with no options offered");
  });
  assert.equal(await interpretPostingsDecision("yes, connect me", []), null);
  assert.equal(spy.mock.callCount(), 0);
});

test("interpretPostingsDecision returns null when the AI call fails, so the caller falls back to the deterministic parser", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  assert.equal(await interpretPostingsDecision("yes, connect me", OPTIONS), null);
});

test("required regression: interpretPostingsDecision maps natural phrasing naming a counterpart to that match's id", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "approve", matchId: 205 }));
  const result = await interpretPostingsDecision("connect me with XYZ Timepieces", OPTIONS);
  assert.deepEqual(result, { action: "approve", matchId: 205 });
});

test("interpretPostingsDecision allows a null matchId when nothing distinguishes which pending match is meant (caller defaults to the most recent)", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "approve", matchId: null }));
  const result = await interpretPostingsDecision("yes, connect me with the seller", [OPTIONS[0]]);
  assert.deepEqual(result, { action: "approve", matchId: null });
});

test("required regression: interpretPostingsDecision returns action: null for a message that isn't actually a decision", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: null, matchId: null }));
  const result = await interpretPostingsDecision("hey how's it going", OPTIONS);
  assert.deepEqual(result, { action: null, matchId: null });
});

test("required regression: interpretPostingsDecision rejects a response with an invalid action rather than trusting it", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "maybe", matchId: 182 }));
  assert.equal(await interpretPostingsDecision("hmm", OPTIONS), null);
});

test("required (safety): interpretPostingsDecision never trusts a matchId that wasn't actually offered", async (t) => {
  t.mock.method(client, "callAiJson", async () => ({ action: "approve", matchId: 999999 }));
  assert.equal(await interpretPostingsDecision("connect me with someone", OPTIONS), null, "a hallucinated/invented match id must never be trusted");
});
