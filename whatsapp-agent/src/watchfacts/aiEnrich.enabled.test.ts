import { test, after } from "node:test";
import assert from "node:assert/strict";

// ENABLE_AI_INVENTORY_ENRICHMENT=true set before config is ever required — separate
// process/file from aiEnrich.disabled.test.ts, matching the codebase's established pattern
// (see groupMonitor.featureFlag.test.ts / groupMonitor.allowedChatIds.test.ts) of testing a
// flag's "off" and "on" behavior in isolated files rather than mutating a live config object
// mid-test.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_INVENTORY_ENRICHMENT = "true";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrichmentModule = require("../ai/enrichment") as typeof import("../ai/enrichment");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { enrichAndSplitListings } = require("./aiEnrich") as typeof import("./aiEnrich");

after(() => inventoryDb._closePoolForTests());

type Row = Parameters<typeof inventoryDb.upsertListings>[0][number];

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
    ...overrides,
  };
}

function enrichedWatch(overrides: Partial<Awaited<ReturnType<typeof enrichmentModule.enrichListingText>>[number]> = {}) {
  return {
    brand: "Rolex",
    model: null,
    referenceRaw: null,
    referenceFamily: null,
    variant: null,
    year: null,
    condition: null,
    price: null,
    currency: null,
    location: null,
    confidence: 0.9,
    evidence: "a",
    ...overrides,
  };
}

test("required regression: a row that already has a real reference never triggers an AI call at all — cost control, not just a no-op split", async (t) => {
  await inventoryDb._resetDbForTests();
  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => {
    throw new Error("must never be called for a row the deterministic parser already handled");
  });
  const rows = [row("a", { ref: "116500LN", description: "some bundle text" })];
  const outcome = await enrichAndSplitListings(rows);
  assert.equal(outcome.rows.length, 1);
  assert.equal(outcome.rows[0].id, "a");
  assert.equal(outcome.rows[0].ref, "116500LN");
  assert.equal(spy.mock.callCount(), 0, "AI must never be called just to confirm a row is already fine");
});

test("required regression: a row WITH an existing ref still goes to AI when its own text is a multi-price bundle dump — a ref alone doesn't prove it's one watch", async (t) => {
  await inventoryDb._resetDbForTests();
  // Mirrors the live reported bug: extractReference grabbed the FIRST reference-shaped token
  // ("116500LN") from a Hong Kong dealer's whole price sheet, so the row already has a `ref` —
  // but hasMultipleDistinctPrices still recognizes the text as a bundle, so this must NOT be
  // fast-pathed past AI just because a ref field happens to be set.
  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => [
    enrichedWatch({ referenceFamily: "116500LN", condition: "Used", price: 210000, currency: "HKD", evidence: "116500ln white 2011 hkd210k" }),
    enrichedWatch({ referenceFamily: "116520", condition: "Used", price: 167000, currency: "HKD", evidence: "116520 black 2010 hkd167k" }),
  ]);
  const rows = [
    row("hk-dump", {
      ref: "116500LN",
      description: "116500ln white 2011 hkd210k\n116520 black 2010 hkd167k",
    }),
  ];
  const outcome = await enrichAndSplitListings(rows);
  assert.equal(spy.mock.callCount(), 1, "a ref-having row that looks like a bundle must still be sent to AI");
  assert.equal(outcome.rows.length, 2, "must split into one row per watch AI found evidence for");
});

test("required regression: an unstructured multi-watch blast with no ref is split into one row per watch AI found evidence for", async (t) => {
  await inventoryDb._resetDbForTests();
  t.mock.method(enrichmentModule, "enrichListingText", async () => [
    enrichedWatch({ referenceFamily: "116500", condition: "Used", price: 199000, currency: "HKD", evidence: "116500 black 2023used 199k" }),
    enrichedWatch({ referenceFamily: "124300", condition: "Used", price: 66000, currency: "HKD", evidence: "124300 green 2023used 66k" }),
  ]);
  const rows = [row("bundle-1", { ref: "", description: "116500 black 2023used 199k\n124300 green 2023used 66k" })];
  const outcome = await enrichAndSplitListings(rows);
  assert.equal(outcome.rows.length, 2, "a blast with no structured ref must split into separate candidates");
  assert.deepEqual(
    outcome.rows.map((r) => r.ref),
    ["116500", "124300"]
  );
  assert.notEqual(outcome.rows[0].id, outcome.rows[1].id);
});

test("required regression: unchanged content since the last enrichment pass is never re-sent to AI", async (t) => {
  await inventoryDb._resetDbForTests();
  const text = "Rolex Daytona 116500LN";
  const hash = enrichmentModule.contentHash(text);
  await inventoryDb.saveAiEnrichment("WF", "FS", "a", hash, []);

  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => {
    throw new Error("must never be called for unchanged content");
  });
  const rows = [row("a", { description: text })];
  const outcome = await enrichAndSplitListings(rows);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(spy.mock.callCount(), 0);
});

test("changed content since the last enrichment pass IS re-sent to AI", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.saveAiEnrichment("WF", "FS", "a", enrichmentModule.contentHash("old text"), []);
  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => []);
  const rows = [row("a", { description: "brand new different text" })];
  await enrichAndSplitListings(rows);
  assert.equal(spy.mock.callCount(), 1);
});
