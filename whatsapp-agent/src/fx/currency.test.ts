import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractNativePrice, formatCurrency, inferCurrency } = require("./currency") as typeof import("./currency");

test("required regression: extractNativePrice reads a currency-code-prefixed amount (HKD)", () => {
  const result = extractNativePrice("Rolex Daytona 116500LN, HKD850,000, box and papers");
  assert.deepEqual(result, { amount: 850000, currency: "HKD", originalText: "HKD850,000" });
});

test("required regression: extractNativePrice reads the HK$ symbol as HKD, never swallowed by the bare $ pattern", () => {
  const result = extractNativePrice("Patek Nautilus 5711, HK$850,000, full set");
  assert.equal(result?.currency, "HKD");
  assert.equal(result?.amount, 850000);
});

test("extractNativePrice binds a trailing ISO code to a bare-dollar amount", () => {
  assert.deepEqual(extractNativePrice("Patek 5712G $100k CAD"), {
    amount: 100000,
    currency: "CAD",
    originalText: "$100k CAD",
  });
});

test("extractNativePrice reads EUR and GBP", () => {
  assert.deepEqual(extractNativePrice("AP Royal Oak, EUR95,000"), { amount: 95000, currency: "EUR", originalText: "EUR95,000" });
  assert.deepEqual(extractNativePrice("Submariner, GBP 8,000"), { amount: 8000, currency: "GBP", originalText: "GBP 8,000" });
});

test("extractNativePrice distinguishes JPY and CNY symbols", () => {
  assert.deepEqual(extractNativePrice("Patek 5712G ¥15,000,000"), {
    amount: 15000000, currency: "JPY", originalText: "¥15,000,000",
  });
  assert.deepEqual(extractNativePrice("Patek 5712G CN¥700,000"), {
    amount: 700000, currency: "CNY", originalText: "CN¥700,000",
  });
});

test("extractNativePrice canonicalizes RMB to CNY", () => {
  assert.deepEqual(extractNativePrice("Patek 5712G RMB 900000"), {
    amount: 900000, currency: "CNY", originalText: "RMB 900000",
  });
});

test("extractNativePrice consumes repeated dot thousands groups", () => {
  assert.deepEqual(extractNativePrice("Patek 5712G €1.250.000"), {
    amount: 1250000, currency: "EUR", originalText: "€1.250.000",
  });
});

test("required regression: a bare $ with no other currency signal resolves to the configured base currency (USD)", () => {
  const result = extractNativePrice("Rolex Daytona 116500LN $28,500");
  assert.deepEqual(result, { amount: 28500, currency: "USD", originalText: "$28,500" });
});

test("required regression: comma-formatted amounts parse correctly", () => {
  assert.equal(extractNativePrice("HKD 1,234,567")?.amount, 1234567);
  assert.equal(extractNativePrice("$26,200")?.amount, 26200);
});

test("required regression: k-notation amounts parse correctly, currency-tagged", () => {
  assert.deepEqual(extractNativePrice("SGD145k full set"), { amount: 145000, currency: "SGD", originalText: "SGD145k" });
  assert.equal(extractNativePrice("$28.5k")?.amount, 28500);
});

test("extractNativePrice returns null when the text names more than one distinct price", () => {
  assert.equal(extractNativePrice("PRICE UPDATE: 116500LN HKD210,000, 116520 HKD167,000"), null);
});

test("extractNativePrice returns null for text with no price at all", () => {
  assert.equal(extractNativePrice("Rolex Daytona 116500LN, box and papers"), null);
});

test("extractNativePrice still returns one price when the same amount is repeated", () => {
  const result = extractNativePrice("HKD850,000 firm, no lowballs — HKD850,000");
  assert.equal(result?.amount, 850000);
  assert.equal(result?.currency, "HKD");
});

test("required regression: formatCurrency matches the exact required display formats", () => {
  assert.equal(formatCurrency(110000, "USD"), "$110,000 USD");
  assert.equal(formatCurrency(95000, "EUR"), "€95,000 EUR");
  assert.equal(formatCurrency(80000, "GBP"), "£80,000 GBP");
  assert.equal(formatCurrency(850000, "HKD"), "HK$850,000 HKD");
  assert.equal(formatCurrency(145000, "SGD"), "S$145,000 SGD");
  assert.equal(formatCurrency(150000, "CAD"), "C$150,000 CAD");
  assert.equal(formatCurrency(170000, "AUD"), "A$170,000 AUD");
});

test("yen currencies format with their distinct symbols", () => {
  assert.equal(formatCurrency(1000000, "JPY"), "¥1,000,000 JPY");
  assert.equal(formatCurrency(700000, "CNY"), "CN¥700,000 CNY");
});

test("required regression: an unknown/unmapped currency still formats with its ISO code, never a wrong symbol", () => {
  assert.equal(formatCurrency(1000000, "CHF"), "1,000,000 CHF");
});

test("required regression: inferCurrency defaults a Hong Kong listing with no detected currency to HKD, never USD", () => {
  assert.equal(inferCurrency(null, "Hong Kong"), "HKD");
  assert.equal(inferCurrency(null, "HK"), "HKD");
  assert.equal(inferCurrency(null, "hong kong"), "HKD", "case-insensitive");
});

test("required regression: inferCurrency never overrides an explicit detected currency", () => {
  assert.equal(inferCurrency("EUR", "Hong Kong"), "EUR");
});

test('required regression: inferCurrency defaults to USD for a broad region ("Asia", spanning several distinct currencies) rather than guessing', () => {
  assert.equal(inferCurrency(null, "Asia"), "USD");
  assert.equal(inferCurrency(null, "North America"), "USD");
  assert.equal(inferCurrency(null, null), "USD");
});
