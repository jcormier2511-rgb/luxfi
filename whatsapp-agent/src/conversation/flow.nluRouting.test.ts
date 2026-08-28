import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Fi NLU routing fix: deterministic action commands first, then the AI intent extractor
// (mocked here), then the legacy regex parser as the final fallback. A pending match must
// never block a new natural-language request, and must never be destroyed just because
// another search starts.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-nlu-routing-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
const TEST_PHONE = "15557778888";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

const LOCATION = "North America";

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Patek Philippe",
    ref: "5712G",
    condition: "New",
    price: "105000",
    location: LOCATION,
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "Patek Philippe 5712G",
    ...overrides,
  };
}

/** A "complete" extraction — location/dial/condition/price all present — so the search runs
 *  immediately instead of asking the one-round follow-up question (that mechanism is already
 *  covered elsewhere, e.g. flow.naturalFollowUp.test.ts; these tests are about routing, not it). */
function extracted(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: {
      intent: "buy",
      brand: null,
      model: null,
      reference: null,
      dial: "any",
      condition: "any",
      year: null,
      boxPapers: null,
      priceMin: null,
      priceMax: 500000,
      currency: "USD",
      location: LOCATION,
      searchText: null,
      confidence: 0.9,
      ...overrides,
    },
    priceUnreliable: false,
  };
}

/** Not a buy/sell intent at all -- exactly what a real model should return for a bare greeting
 *  or anything else that isn't a search request; the caller falls back to the legacy parser. */
const NOT_A_REQUEST = { intent: { intent: "unknown", brand: null, model: null, reference: null, dial: null, condition: null, year: null, boxPapers: null, priceMin: null, priceMax: null, currency: "USD", location: null, searchText: null, confidence: 0 }, priceUnreliable: false };

test("required: the AI intent extractor drives the search (buy) — no leftover lead-in phrase in the query", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("nlu-buy-1")], new Date().toISOString());

  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    /5712g/i.test(text)
      ? extracted({ intent: "buy", brand: "Patek Philippe", reference: "5712G", searchText: "Patek Philippe 5712G" })
      : NOT_A_REQUEST
  );

  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "want to buy a patek 5712G");

  assert.ok(result.messages.some((m) => /Potential Match/.test(m)), "the AI-extracted search must actually run and find the listing");
  assert.ok(!result.messages.some((m) => /to buy a patek/i.test(m)), "the raw lead-in phrase must never leak into any reply");
});

test("required: the AI intent extractor drives the search (sell)", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("nlu-sell-1", { type: "WTB" as const })], new Date().toISOString());

  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    /5712\b/i.test(text)
      ? extracted({ intent: "sell", brand: "Patek Philippe", reference: "5712", searchText: "Patek Philippe 5712" })
      : NOT_A_REQUEST
  );

  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "I want to sell a Patek 5712");

  assert.ok(result.messages.some((m) => /Potential Match/.test(m)));
  assert.ok(!result.messages.some((m) => /i want to sell/i.test(m)));
});

test("required: a new buy/sell request is never blocked by a pending match", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("pending-1", { ref: "5712G" }), fsRow("pending-2", { ref: "116500LN", brand: "Rolex", item: "item-pending-2" })],
    new Date().toISOString()
  );

  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) => {
    if (/daytona/i.test(text)) {
      return extracted({ intent: "buy", brand: "Rolex", model: "Daytona", reference: "116500LN", searchText: "Rolex Daytona 116500LN" });
    }
    if (/5712g/i.test(text)) {
      return extracted({ intent: "buy", brand: "Patek Philippe", reference: "5712G", searchText: "Patek Philippe 5712G" });
    }
    return NOT_A_REQUEST;
  });

  await handleIncomingMessage(phone, "hi");
  const first = await handleIncomingMessage(phone, "want to buy a patek 5712G");
  assert.ok(first.state.pendingMatches, "the first search must leave a pending match awaiting approve/pass");

  // A second, completely different natural-language request while the first is still pending.
  const second = await handleIncomingMessage(phone, "looking for a Rolex Daytona 116500LN");
  assert.ok(second.messages.some((m) => /Potential Match/.test(m)), "the new request must run, not get swallowed as a decision on the old match");
  assert.ok(second.state.pendingMatches, "a new search starts its own new monitor");
});

test("required: a pending match is preserved (never deleted) when a new search comes back with zero results", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("preserve-1")], new Date().toISOString());

  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) => {
    if (/5712g/i.test(text)) return extracted({ intent: "buy", brand: "Patek Philippe", reference: "5712G", searchText: "Patek Philippe 5712G" });
    if (/99999zz/i.test(text)) return extracted({ intent: "buy", brand: "Audemars Piguet", reference: "99999ZZ", searchText: "Audemars Piguet 99999ZZ" });
    return NOT_A_REQUEST;
  });

  await handleIncomingMessage(phone, "hi");
  const first = await handleIncomingMessage(phone, "want to buy a patek 5712G");
  assert.ok(first.state.pendingMatches, "setup: a match must be pending before the empty search");

  const second = await handleIncomingMessage(phone, "want to buy an AP 99999ZZ");
  assert.ok(!second.messages.some((m) => /Potential Match/.test(m)), "the second search itself found nothing");
  assert.ok(second.state.pendingMatches, "the FIRST search's pending match must survive an unrelated empty search");
  assert.equal(second.state.pendingMatches!.matches.length, 1);

  // The original match is still resolvable afterward.
  const approve = await handleIncomingMessage(phone, "approve 1");
  assert.match(approve.messages.join("\n"), /^Approved #1/);
});

test("required: 'approve' with no number applies to the latest unresolved match, not always #1", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("latest-1", { ref: "5712G" }), fsRow("latest-2", { ref: "5712G" }), fsRow("latest-3", { ref: "5712G" })],
    new Date().toISOString()
  );
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    /5712g/i.test(text)
      ? extracted({ intent: "buy", brand: "Patek Philippe", reference: "5712G", searchText: "Patek Philippe 5712G" })
      : NOT_A_REQUEST
  );

  await handleIncomingMessage(phone, "hi");
  const search = await handleIncomingMessage(phone, "want to buy a patek 5712G");
  assert.equal(search.state.pendingMatches!.matches.length, 3, "setup: three candidates must be shown");

  // #3 (the LAST one) is decided first, on purpose -- proves "latest" means "most recent
  // still-undecided entry," not "always #1" and not "next in sequence."
  await handleIncomingMessage(phone, "pass 3");
  const result = await handleIncomingMessage(phone, "approve");
  assert.match(result.messages.join("\n"), /^Approved #2/, "with #3 already decided, a bare 'approve' must resolve to #2 (the new latest unresolved), never re-hit #1 by default");
});

test("required: a reference-only message (5712G) never produces a $2 price on the resulting card", async (t) => {
  const phone = TEST_PHONE;
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("ref-only-1", { price: "105000" })], new Date().toISOString());
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    /5712g/i.test(text)
      ? extracted({ intent: "buy", brand: "Patek Philippe", reference: "5712G", searchText: "Patek Philippe 5712G", priceMin: null })
      : NOT_A_REQUEST
  );

  await handleIncomingMessage(phone, "hi");
  const result = await handleIncomingMessage(phone, "want to buy a patek 5712G");
  const joined = result.messages.join("\n");
  assert.doesNotMatch(joined, /\$2\b/, "5712G must never surface as a $2 price anywhere in the reply");
  assert.match(joined, /\$105,000/, "the listing's real price must still display correctly, comma-formatted");
});
