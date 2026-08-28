import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { InventoryListing } from "../types";
import { _resetRatesForTests, _setRatesForTests } from "../fx/rates";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

let active: InventoryListing[] = [];
const inventoryPath = require.resolve("../watchfacts/inventoryDb");
require.cache[inventoryPath] = {
  id: inventoryPath, filename: inventoryPath, loaded: true,
  exports: { getActiveListings: async () => active },
  children: [], paths: [], parent: null,
} as unknown as NodeModule;
const { findMatches, attachCurrencyDisplay, formatMatchCard } = require("./engine") as typeof import("./engine");

afterEach(() => _resetRatesForTests());
after(() => { delete require.cache[inventoryPath]; });

function listing(id: string, price: string): InventoryListing {
  return {
    id, type: "FS", category: "watches", item: "Patek Nautilus", brand: "Patek Philippe",
    ref: "5712G", condition: "Pre-owned", price, location: "", contactName: "Seller",
    contactPhone: "1", source: "WA-Group", rating: "", description: `Patek 5712G ${price}`,
  };
}

test("matches only listings whose converted USD price is within the USD buyer budget", async () => {
  _setRatesForTests({ base: "USD", rates: { HKD: 7.8125 }, fetchedAt: new Date() });
  active = [listing("qualifies", "HKD 820,000"), listing("too-high", "HKD 900,000")];
  const matches = await findMatches({ action: "buy", query: "Patek 5712G" }, 5, { priceMax: 110000, priceCurrency: "USD" });
  assert.deepEqual(matches.map(({ id }) => id), ["qualifies"]);
  const [withCurrency] = await attachCurrencyDisplay([{ listing: matches[0] }]);
  assert.match(formatMatchCard(matches[0], 0, "buy", undefined, undefined, withCurrency.currencyDisplay), /Asking: HK\$820,000 HKD/);
  assert.match(formatMatchCard(matches[0], 0, "buy", undefined, undefined, withCurrency.currencyDisplay), /Approximately: \$104,960 USD/);
});

test("a missing rate excludes a foreign-currency listing instead of comparing nominal amounts", async () => {
  _setRatesForTests({ base: "USD", rates: {}, fetchedAt: new Date() });
  active = [listing("unknown-conversion", "AED 100,000")];
  const matches = await findMatches({ action: "buy", query: "Patek 5712G" }, 5, { priceMax: 110000, priceCurrency: "USD" });
  assert.deepEqual(matches, []);
});
