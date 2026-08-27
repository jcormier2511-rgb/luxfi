import { test, after } from "node:test";
import assert from "node:assert/strict";

// ENABLE_AI_MATCHING is deliberately left UNSET here — proving the documented default
// (config.aiMatching.enabled === false) keeps AI enrichment completely inert, matching every
// other feature flag's "off means off, not just untested" convention in this codebase.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

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

test("ENABLE_AI_MATCHING defaults to disabled", () => {
  assert.equal(config.aiMatching.enabled, false);
});

test("enrichAndSplitListings passes rows through unchanged, without calling AI, while disabled", async (t) => {
  const spy = t.mock.method(enrichmentModule, "enrichListingText", async () => {
    throw new Error("must never be called while ENABLE_AI_MATCHING is off");
  });
  const rows = [row("a", { description: "Rolex Daytona 116500LN" })];
  const outcome = await enrichAndSplitListings(rows);
  assert.deepEqual(outcome.rows, rows);
  assert.deepEqual(outcome.toSave, []);
  assert.equal(spy.mock.callCount(), 0);
});
