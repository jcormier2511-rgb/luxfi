import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Live-reported gap: MARKET_REFERENCE_COMMAND (flow.ts) only recognizes a narrow, fixed set of
// trigger words ("market"/"pulse"/"price"/"what's the market for") -- genuinely natural phrasings
// like "what the value of 116500LN" or "how many buyers are available for 116500LN" matched
// nothing at all, and "how many sellers are selling X" was actively misread as the user wanting
// to sell that watch themselves (silently starting a sell-listing draft). This is the AI-routed
// fallback: only tried once every deterministic market pattern has already missed, and only for
// the AI-matching test phone (config.isAiMatchingEnabledForPhone) -- the same narrow-rollout gate
// every other AI-routed feature in this file uses.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-mp-nl-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "15556660001";
const OTHER_PHONE = "15556660002";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function priceCheck(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: {
      intent: "price_check",
      brand: null,
      model: null,
      reference: "116500LN",
      dial: null,
      condition: null,
      year: null,
      boxPapers: null,
      priceMin: null,
      priceMax: null,
      currency: "USD",
      location: null,
      searchText: null,
      confidence: 0.9,
      ...overrides,
    },
    priceUnreliable: false,
  };
}

const NOT_A_REQUEST = { intent: { intent: "unknown", brand: null, model: null, reference: null, dial: null, condition: null, year: null, boxPapers: null, priceMin: null, priceMax: null, currency: "USD", location: null, searchText: null, confidence: 0 }, priceUnreliable: false };

test("required: a natural-language value/price question with no trigger word still resolves to Market Pulse", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  t.mock.method(intentExtractorModule, "extractIntent", async () => priceCheck());

  const result = await handleIncomingMessage(phone, "what the value of 116500LN");
  assert.match(result.messages.join("\n"), /Market Pulse — 116500LN/);
});

test("required: 'how many buyers are available for X' resolves to Market Pulse, not a generic fallback", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  t.mock.method(intentExtractorModule, "extractIntent", async () => priceCheck());

  const result = await handleIncomingMessage(phone, "how many buyers are available for 116500LN");
  assert.match(result.messages.join("\n"), /Market Pulse — 116500LN/);
  assert.doesNotMatch(result.messages.join("\n"), /not sure I understood/i);
});

test("required regression: 'how many sellers are selling X' must never be misread as the user wanting to sell it themselves", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  t.mock.method(intentExtractorModule, "extractIntent", async () => priceCheck());

  const result = await handleIncomingMessage(phone, "how many sellers are selling 116500LN");
  assert.match(result.messages.join("\n"), /Market Pulse — 116500LN/);
  assert.equal(result.state.pendingSellIntake, undefined, "must never silently start a sell-listing draft for an informational question");
});

test("required: a low-confidence or non-price_check extraction still falls through to ordinary handling, never hijacking an unrelated message", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  t.mock.method(intentExtractorModule, "extractIntent", async () => NOT_A_REQUEST);

  const result = await handleIncomingMessage(phone, "hey how's it going");
  assert.doesNotMatch(result.messages.join("\n"), /Market Pulse/);
});

test("required: a low-confidence price_check (confidence under threshold) does not trigger Market Pulse either", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  t.mock.method(intentExtractorModule, "extractIntent", async () => priceCheck({ confidence: 0.2 }));

  const result = await handleIncomingMessage(phone, "what the value of 116500LN");
  assert.doesNotMatch(result.messages.join("\n"), /Market Pulse — 116500LN/);
});

test("required: a deterministic market command never even calls the AI extractor -- the cheap path always wins first", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  let calls = 0;
  t.mock.method(intentExtractorModule, "extractIntent", async () => {
    calls += 1;
    return NOT_A_REQUEST;
  });

  const result = await handleIncomingMessage(phone, "market pulse 116500LN");
  assert.match(result.messages.join("\n"), /Market Pulse — 116500LN/);
  assert.equal(calls, 0, "the deterministic pattern already matched -- the AI extractor must never be called at all");
});

test("required (safety): the AI-routed fallback is inert for a phone NOT on the AI-matching test-phone allowlist", async (t) => {
  const phone = OTHER_PHONE;
  resetState(phone);
  await postingsDb._resetDbForTests();
  let calls = 0;
  t.mock.method(intentExtractorModule, "extractIntent", async () => {
    calls += 1;
    return priceCheck();
  });

  const result = await handleIncomingMessage(phone, "what the value of 116500LN");
  assert.equal(calls, 0, "a non-allowlisted phone must never reach the AI extractor at all");
  assert.doesNotMatch(result.messages.join("\n"), /Market Pulse — 116500LN/);
});
