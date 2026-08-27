import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Master flag on, API key configured, and a specific test phone — set before config (and
// therefore engine.ts, which reads isAiMatchingEnabledForPhone) is ever required. Every
// assertion below either uses TEST_PHONE (hybrid/AI path active) or OTHER_PHONE (must stay on
// the plain deterministic path regardless of the flag) to prove the restriction actually holds.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-hybrid-engine-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15550001111";
const OTHER_PHONE = "15559998888";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("./engine") as typeof import("./engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const queryInterpreterModule = require("../ai/queryInterpreter") as typeof import("../ai/queryInterpreter");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rerankModule = require("../ai/rerank") as typeof import("../ai/rerank");
const { upsertListings, _resetDbForTests, _closePoolForTests } = inventoryDb;
const { findMatchesHybrid } = engine;

after(async () => {
  await _closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

type Row = Parameters<typeof upsertListings>[0][number];

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `item-${id}`,
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    detailUrl: `https://watchfacts.com/flash-sales/${id}`,
    ...overrides,
  };
}

function interpreted(overrides: Partial<Awaited<ReturnType<typeof queryInterpreterModule.interpretQuery>>> = {}) {
  return {
    action: "buy" as const,
    brand: "Rolex",
    referenceFamily: null,
    maxPrice: null,
    minPrice: null,
    location: null,
    hardRequirements: [],
    preferences: [],
    ...overrides,
  };
}

test("outside the test phone, findMatchesHybrid never calls AI at all — plain deterministic matching only", async (t) => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN" })], new Date().toISOString());
  const spy = t.mock.method(queryInterpreterModule, "interpretQuery", async () => {
    throw new Error("must never be called for a non-test phone");
  });
  const results = await findMatchesHybrid(OTHER_PHONE, { action: "buy", query: "Rolex Daytona 116500LN" }, 5);
  assert.equal(results.length, 1);
  assert.equal(spy.mock.callCount(), 0);
});

test("required acceptance: active 116500LN matches query 116500", async (t) => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN", description: "Rolex Daytona 116500LN" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ referenceFamily: "116500" }));
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) =>
    candidates.map((c) => ({ id: c.id, explanation: "matches requested reference", evidence: "116500LN" }))
  );
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].listing.id, "a");
});

test("required acceptance: 116508-0013 never matches query 116500, even if AI tries to pick it", async (t) => {
  await _resetDbForTests();
  await upsertListings(
    [row("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona 116508-0013 bundle lot" })],
    new Date().toISOString()
  );
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ referenceFamily: "116500" }));
  // Simulates a misbehaving/hallucinating AI reranker that tries to pick the wrong watch anyway.
  t.mock.method(rerankModule, "rerankCandidates", async () => [{ id: "wrong-ref", explanation: "same brand", evidence: "Rolex Daytona 116508-0013 bundle lot" }]);
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(results.length, 0, "a candidate with an explicitly different reference must never surface, regardless of what AI picks");
});

test("required acceptance: an inactive 116500LN listing never matches", async (t) => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN" })], new Date().toISOString());
  // A later sync that no longer sees "a" marks it inactive — the same real path production
  // syncs use, not a hand-set flag.
  await upsertListings([row("b", { brand: "Rolex", ref: "999999" })], new Date().toISOString());
  await inventoryDb.markMissingInactive("WF", "FS", ["b"], new Date().toISOString());

  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ referenceFamily: "116500" }));
  let sentIds: string[] = [];
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) => {
    sentIds = candidates.map((c) => c.id);
    return [];
  });
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(results.length, 0);
  assert.ok(!sentIds.includes("a"), "the inactive listing must never even be included in the pool sent to AI");
});

test("required acceptance: an active row with a blank ref but clear 116500LN evidence in its own text is matched", async (t) => {
  await _resetDbForTests();
  await upsertListings(
    [row("a", { brand: "Rolex", ref: "", description: "Rolex Daytona 116500LN, box and papers" })],
    new Date().toISOString()
  );
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ referenceFamily: "116500" }));
  t.mock.method(rerankModule, "rerankCandidates", async (_q: unknown, candidates: { id: string }[]) =>
    candidates.map((c) => ({ id: c.id, explanation: "reference found in listing text", evidence: "Rolex Daytona 116500LN, box and papers" }))
  );
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(results.length, 1, "a blank structured ref must not block a match when the reference is clearly present in the listing's own text");
  assert.equal(results[0].listing.id, "a");
});

test("required acceptance: AI cannot return a candidate without evidence from the active listing", async (t) => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => interpreted({ referenceFamily: "116500" }));
  // Deliberately NOT mocking rerankModule.rerankCandidates here — using the REAL
  // implementation (which already enforces evidence-substring validation, see rerank.test.ts)
  // and only faking its underlying AI call, so this proves the hybrid engine actually goes
  // through that real contract end-to-end rather than trusting whatever a mock hands it.
  const client = require("../ai/client") as typeof import("../ai/client");
  t.mock.method(client, "callAiJson", async () => [{ id: "a", explanation: "fabricated", evidence: "text that was never in this listing" }]);
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(results.length, 0, "an unverifiable pick must never surface as a match");
});

test("required acceptance: no arbitrary fallback inventory — an AI outage falls back to deterministic matching, not to an unrelated pool", async (t) => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN", description: "Rolex Daytona 116500LN" })], new Date().toISOString());
  t.mock.method(queryInterpreterModule, "interpretQuery", async () => null); // simulates an interpretation failure
  const results = await findMatchesHybrid(TEST_PHONE, { action: "buy", query: "buy Rolex Daytona 116500LN" }, 5);
  // Falls back to plain findMatches, which itself never shows an unrelated listing for a
  // reference-specific query (see engine.test.ts) — proving the fallback path is the SAME
  // strict deterministic engine, not a separate, looser "show something" pool.
  assert.equal(results.length, 1);
  assert.equal(results[0].listing.id, "a");
});
