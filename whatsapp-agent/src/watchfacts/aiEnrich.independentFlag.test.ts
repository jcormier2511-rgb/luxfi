import { test, after } from "node:test";
import assert from "node:assert/strict";

// ENABLE_AI_MATCHING=true but ENABLE_AI_INVENTORY_ENRICHMENT deliberately left UNSET — proves
// the two flags are independent: turning on AI for one test phone's searches must never
// silently also start running AI enrichment against the whole inventory feed.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "15550001111";
delete process.env.ENABLE_AI_INVENTORY_ENRICHMENT;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrichmentModule = require("../ai/enrichment") as typeof import("../ai/enrichment");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { enrichAndSplitListings } = require("./aiEnrich") as typeof import("./aiEnrich");

after(() => inventoryDb._closePoolForTests());

test("required regression: ENABLE_AI_MATCHING alone never turns on inventory-sync enrichment", () => {
  assert.equal(config.aiMatching.enabled, true);
  assert.equal(config.aiMatching.enrichmentEnabled, false, "these two flags must be independent");
});

test("required regression: enrichAndSplitListings stays inert with ENABLE_AI_MATCHING=true but ENABLE_AI_INVENTORY_ENRICHMENT unset", async (t) => {
  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => {
    throw new Error("must never be called — inventory enrichment has its own separate flag");
  });
  const rows = [
    {
      id: "a",
      type: "FS" as const,
      category: "watches",
      item: "item-a",
      brand: "",
      ref: "",
      condition: "",
      price: "1000",
      location: "",
      contactName: "seller-a",
      contactPhone: "123",
      rating: "",
      description: "Rolex Daytona 116500LN",
    },
  ];
  const outcome = await enrichAndSplitListings(rows);
  assert.deepEqual(outcome.rows, rows);
  assert.equal(spy.mock.callCount(), 0);
});
