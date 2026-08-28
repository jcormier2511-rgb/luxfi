import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Fi Concierge Stage 3: "I'll take the first one" / "pass on that" should work the same as the
// literal "approve <n>"/"pass <n>" format — only for the AI matching test phone, and only ever
// producing the same {action, index} shape handleDecision already accepts from the deterministic
// parser, so trial/entitlement rules are completely unaffected either way.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-decisions-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15550003333";
const OTHER_PHONE = "15559994444";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const queryInterpreterModule = require("../ai/queryInterpreter") as typeof import("../ai/queryInterpreter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rerankModule = require("../ai/rerank") as typeof import("../ai/rerank");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const decisionModule = require("../ai/decisionInterpreter") as typeof import("../ai/decisionInterpreter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatReplyModule = require("../ai/chatReply") as typeof import("../ai/chatReply");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "24500",
    // The default `interpreted()` fixture below now specifies location: "USA" (all four
    // required fields present, so these decision-handling tests never trip the missing-fields
    // follow-up) — the row needs a matching location or the new location hard-filter would
    // exclude it before a match ever gets shown at all.
    location: "North America",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

function interpreted(overrides: Partial<Awaited<ReturnType<typeof queryInterpreterModule.interpretQuery>>> = {}) {
  return {
    action: "buy" as const,
    brand: "Rolex",
    referenceFamily: "116500",
    maxPrice: 27000,
    minPrice: null,
    // All four required fields present by default — these tests exercise decision handling,
    // not the missing-fields follow-up (see flow.naturalFollowUp.test.ts for that).
    location: "USA",
    dialColor: "black",
    condition: "pre-owned",
    hardRequirements: [],
    preferences: [],
    ...overrides,
  };
}

/** Puts a fresh TEST_PHONE contact into a state with one pending match awaiting a decision. */
async function setUpOnePendingMatch(t: { mock: { method: Function } }): Promise<void> {
  resetState(TEST_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a")], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted());
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) =>
    candidates.map((c) => ({ id: c.id, explanation: "matches request", evidence: "Rolex Daytona 116500LN" }))
  );
  await handleIncomingMessage(TEST_PHONE, "hi");
  await handleIncomingMessage(TEST_PHONE, "buy Rolex Daytona 116500LN");
}

test("required regression: natural phrasing approves the shown match the same way 'approve 1' would", async (t) => {
  await setUpOnePendingMatch(t);
  t.mock.method(decisionModule, "interpretDecision", async () => ({ action: "approve", index: 1 }));

  const result = await handleIncomingMessage(TEST_PHONE, "I'll take that one");
  assert.ok(result.messages.some((m) => /^Approved #1/.test(m)), "natural approval phrasing must actually approve the match");
});

test("required regression: natural phrasing passes on the shown match without needing the literal word 'pass'", async (t) => {
  await setUpOnePendingMatch(t);
  t.mock.method(decisionModule, "interpretDecision", async () => ({ action: "pass", index: 1 }));

  const result = await handleIncomingMessage(TEST_PHONE, "not interested, thanks");
  assert.ok(result.messages.some((m) => /Passing on #1/.test(m)), "natural pass phrasing must actually record the pass");
});

test("a null index defaults to the first match, same as the deterministic 'approve' parser", async (t) => {
  await setUpOnePendingMatch(t);
  t.mock.method(decisionModule, "interpretDecision", async () => ({ action: "approve", index: null }));

  const result = await handleIncomingMessage(TEST_PHONE, "sure, let's do it");
  assert.ok(result.messages.some((m) => /^Approved #1/.test(m)));
});

test("required regression: when the AI interpretation isn't actually a decision, it falls through to the ordinary 'nothing matched' handling", async (t) => {
  await setUpOnePendingMatch(t);
  t.mock.method(decisionModule, "interpretDecision", async () => ({ action: null, index: null }));
  t.mock.method(chatReplyModule, "generateGeneralChatReply", async () => null); // simulate AI unavailable for the chat-reply step too

  const result = await handleIncomingMessage(TEST_PHONE, "what's the weather like");
  assert.ok(
    result.messages.some((m) => /Reply "approve <number>" or "pass <number>"/.test(m)),
    "a non-decision message must never be forced into an approve/pass action"
  );
});

test("required regression: a non-decision message while matches are pending can still get a natural assistant reply, not just the robotic reminder", async (t) => {
  await setUpOnePendingMatch(t);
  t.mock.method(decisionModule, "interpretDecision", async () => ({ action: null, index: null }));
  t.mock.method(chatReplyModule, "generateGeneralChatReply", async (_text: string, pendingCount: number) => {
    assert.equal(pendingCount, 1, "the pending match count must be passed through as context");
    return "Hey! Still got that match waiting on your reply above whenever you're ready.";
  });

  const result = await handleIncomingMessage(TEST_PHONE, "hi");
  assert.ok(
    result.messages.includes("Hey! Still got that match waiting on your reply above whenever you're ready."),
    "a friendly message with pending matches must get a natural reply instead of the canned reminder"
  );
});

test("a non-test phone's decisions are unaffected — only the literal 'approve <n>'/'pass <n>' format works", async (t) => {
  resetState(OTHER_PHONE);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("a")], new Date().toISOString());
  const spy = t.mock.method(decisionModule, "interpretDecision", async () => {
    throw new Error("must never be called for a non-test phone");
  });

  // A non-AI phone still goes through the one-time price/location/dial/condition interview
  // before its first search — answer each with "any" to get to the match card.
  await handleIncomingMessage(OTHER_PHONE, "hi");
  await handleIncomingMessage(OTHER_PHONE, "buy Rolex Daytona 116500LN");
  await handleIncomingMessage(OTHER_PHONE, "any");
  await handleIncomingMessage(OTHER_PHONE, "any");
  await handleIncomingMessage(OTHER_PHONE, "any");
  const searchResult = await handleIncomingMessage(OTHER_PHONE, "any");
  assert.ok(searchResult.messages.some((m) => /Potential Match/.test(m)), "plain deterministic matching must still find the listing");

  const result = await handleIncomingMessage(OTHER_PHONE, "I'll take that one");
  assert.ok(
    result.messages.some((m) => /Reply "approve <number>" or "pass <number>"/.test(m)),
    "natural phrasing must not be interpreted as a decision for a non-test phone"
  );
  assert.equal(spy.mock.callCount(), 0);
});
