import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { InventoryListing } from "../types";
import { setExchangeRateProviderForTests } from "./currency";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

let active: InventoryListing[] = [];
const inventoryPath = require.resolve("../watchfacts/inventoryDb");
require.cache[inventoryPath] = {
  id: inventoryPath, filename: inventoryPath, loaded: true,
  // Both readers the engine uses. findCandidateListings narrows in SQL against a real database;
  // these fixtures are already one reference, so the double returns the same pool for either.
  exports: { getActiveListings: async () => active, findCandidateListings: async () => active },
  children: [], paths: [], parent: null,
} as unknown as NodeModule;
const { findMatches, formatMatchCard } = require("./engine") as typeof import("./engine");

afterEach(() => setExchangeRateProviderForTests());
after(() => { delete require.cache[inventoryPath]; });

function listing(id: string, price: string): InventoryListing {
  return {
    id, type: "FS", category: "watches", item: "Patek Nautilus", brand: "Patek Philippe",
    ref: "5712G", condition: "Pre-owned", price, location: "", contactName: "Seller",
    contactPhone: "1", source: "WA-Group", rating: "", description: `Patek 5712G ${price}`,
  };
}

test("matches only listings whose converted USD price is within the USD buyer budget", async () => {
  setExchangeRateProviderForTests(async (currency) => currency === "HKD" ? 0.128 : null);
  active = [listing("qualifies", "HKD 820,000"), listing("too-high", "HKD 900,000")];
  const matches = await findMatches({ action: "buy", query: "Patek 5712G" }, 5, { priceMax: 110000, priceCurrency: "USD" });
  assert.deepEqual(matches.map(({ id }) => id), ["qualifies"]);
  assert.match(formatMatchCard(matches[0], 0, "buy"), /HK\$820,000 \(USD \$104,960\)/);
});

test("a missing rate excludes a foreign-currency listing instead of comparing nominal amounts", async () => {
  setExchangeRateProviderForTests(async () => null);
  active = [listing("unknown-conversion", "AED 100,000")];
  const matches = await findMatches({ action: "buy", query: "Patek 5712G" }, 5, { priceMax: 110000, priceCurrency: "USD" });
  assert.deepEqual(matches, []);
});
