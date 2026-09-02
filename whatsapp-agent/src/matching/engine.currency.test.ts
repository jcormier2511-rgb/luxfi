import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-engine-currency-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPEN_EXCHANGE_RATES_APP_ID = "test-app-id";
process.env.FX_MAX_STALENESS_HOURS = "24";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("./engine") as typeof import("./engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rates = require("../fx/rates") as typeof import("../fx/rates");
const { upsertListings, _resetDbForTests, _closePoolForTests } = inventoryDb;
const { findMatches, attachCurrencyDisplay, formatMatchCard } = engine;

after(async () => {
  await _closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

beforeEach(() => {
  rates._resetRatesForTests();
});

type Row = Parameters<typeof upsertListings>[0][number];

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "ASK",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    detailUrl: `https://watchfacts.com/flash-sales/${id}`,
    ...overrides,
  };
}

const FRESH_RATES = { base: "USD", rates: { HKD: 7.8, EUR: 0.92 }, fetchedAt: new Date() };

test("required regression: budget enforcement compares the CONVERTED price — spec's exact example (HK$850,000 vs $110,000 budget)", async () => {
  rates._setRatesForTests(FRESH_RATES);
  await _resetDbForTests();
  await upsertListings(
    [row("hkd-listing", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 110000 });
  assert.equal(matches.length, 1, "HK$850,000 converts to ~$109,000 USD, under the $110,000 budget");
});

test("required regression: a listing that's over budget only AFTER conversion is still excluded", async () => {
  rates._setRatesForTests(FRESH_RATES);
  await _resetDbForTests();
  // HK$1,000,000 / 7.8 ≈ $128,205 USD — over a $110,000 budget, even though the bare native
  // number (1,000,000) looks nowhere near it.
  await upsertListings(
    [row("hkd-over-budget", { nativePriceAmount: 1000000, nativeCurrency: "HKD", originalPriceText: "HK$1,000,000" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 110000 });
  assert.equal(matches.length, 0, "the converted USD amount is over budget and must be excluded, even though the native HKD number looks small");
});

test("required regression: stale rates never let an unconverted listing count as confidently within budget", async () => {
  const staleRates = { ...FRESH_RATES, fetchedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) };
  rates._setRatesForTests(staleRates);
  await _resetDbForTests();
  await upsertListings(
    [row("hkd-stale", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 110000 });
  assert.equal(matches.length, 0, "stale rates can't confirm the converted amount is within budget, so it must be excluded rather than assumed");
});

test("a listing already in the base currency (USD) is compared directly — no conversion attempted", async () => {
  rates._resetRatesForTests(); // no rates loaded at all — proves this path never needs them
  await _resetDbForTests();
  await upsertListings(
    [row("usd-listing", { nativePriceAmount: 95000, nativeCurrency: "USD", originalPriceText: "$95,000" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 110000 });
  assert.equal(matches.length, 1);
});

test("required regression: formatMatchCard shows both currencies in the required display format", async () => {
  rates._setRatesForTests(FRESH_RATES);
  const listing = { ...row("card-1", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" }), source: "WF" };
  const [withCurrency] = await attachCurrencyDisplay([{ listing }]);
  const card = formatMatchCard(listing, 0, "buy", undefined, undefined, withCurrency.currencyDisplay);
  assert.match(card, /Asking: HK\$850,000 HKD/);
  assert.match(card, /Approximately: \$108,974 USD \(estimate — excludes shipping, fees, duties, and taxes\)/);
});

test("required regression: formatMatchCard shows the unavailable caveat instead of a stale/guessed estimate", async () => {
  const staleRates = { ...FRESH_RATES, fetchedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) };
  rates._setRatesForTests(staleRates);
  const listing = { ...row("card-2", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" }), source: "WF" };
  const [withCurrency] = await attachCurrencyDisplay([{ listing }]);
  const card = formatMatchCard(listing, 0, "buy", undefined, undefined, withCurrency.currencyDisplay);
  assert.match(card, /Asking: HK\$850,000 HKD/, "the original native price must still be shown, never dropped");
  assert.match(card, /Currency conversion temporarily unavailable\./);
  assert.doesNotMatch(card, /Approximately/, "no converted figure must be shown when it can't be confirmed");
});

test("a listing with no native currency info renders exactly as it always has (plain $ price line)", async () => {
  const listing = { ...row("card-3", { price: "28500" }), source: "WF" };
  const [withCurrency] = await attachCurrencyDisplay([{ listing }]);
  assert.equal(withCurrency.currencyDisplay, undefined);
  const card = formatMatchCard(listing, 0, "buy", undefined, undefined, withCurrency.currencyDisplay);
  assert.match(card, /Asking: \$28,500/);
  assert.doesNotMatch(card, /Approximately|unavailable/i);
});
