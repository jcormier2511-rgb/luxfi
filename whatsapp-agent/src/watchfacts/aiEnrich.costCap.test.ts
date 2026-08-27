import { test, after } from "node:test";
import assert from "node:assert/strict";

// A tiny cap set before config is ever required, so this test proves the cap actually limits
// AI calls without needing to generate hundreds of rows to exercise a realistic default.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_INVENTORY_ENRICHMENT = "true";
process.env.AI_ENRICHMENT_MAX_PER_SYNC = "2";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
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

test("AI_ENRICHMENT_MAX_PER_SYNC is read into config", () => {
  assert.equal(config.aiMatching.enrichmentMaxPerSync, 2);
});

test("required regression: a sync batch larger than the cap only calls AI up to the cap, leaving the rest for a later sync", async (t) => {
  await inventoryDb._resetDbForTests();
  let calls = 0;
  t.mock.method(enrichmentModule, "enrichListingText", async () => {
    calls++;
    return [];
  });

  const rows = [
    row("a", { description: "unstructured blast a" }),
    row("b", { description: "unstructured blast b" }),
    row("c", { description: "unstructured blast c" }),
    row("d", { description: "unstructured blast d" }),
    row("e", { description: "unstructured blast e" }),
  ];
  const outcome = await enrichAndSplitListings(rows);

  assert.equal(calls, 2, "must stop calling AI once the per-sync cap is reached");
  assert.equal(outcome.rows.length, 5, "rows past the cap are still passed through untouched, not dropped");
  assert.equal(outcome.toSave.length, 2, "only the rows actually sent to AI get a hash/enrichment saved");
});

test("a row past the cap on one sync is retried (not permanently skipped) on the next sync", async (t) => {
  await inventoryDb._resetDbForTests();
  let calls = 0;
  t.mock.method(enrichmentModule, "enrichListingText", async () => {
    calls++;
    return [];
  });

  const rows = [row("a", { description: "a" }), row("b", { description: "b" }), row("c", { description: "c" })];
  const first = await enrichAndSplitListings(rows); // cap=2: "a" and "b" get processed, "c" does not
  // Mirrors the real production wiring (syncInventory.ts): the caller persists `toSave` AFTER
  // enrichAndSplitListings returns — this function itself never writes to the cache table.
  for (const item of first.toSave) {
    await inventoryDb.saveAiEnrichment("WF", item.type, item.externalId, item.hash, item.enrichment);
  }

  const second = await enrichAndSplitListings(rows);
  // "a" and "b" are now unchanged since last time (cached) — skipped for that reason, not the
  // cap — leaving room under the cap for "c" to finally go through.
  assert.equal(calls, 3, "the row skipped by the cap last time must still get processed once capacity is free");
  assert.equal(second.toSave.length, 1);
  assert.equal(second.toSave[0].externalId, "c");
});
