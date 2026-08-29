import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractNativePrice, formatCurrency } = require("./currency") as typeof import("./currency");

test("required regression: extractNativePrice reads a currency-code-prefixed amount (HKD)", () => {
  const result = extractNativePrice("Rolex Daytona 116500LN, HKD850,000, box and papers");
  assert.deepEqual(result, { amount: 850000, currency: "HKD", originalText: "HKD850,000" });
});

test("required regression: extractNativePrice reads the HK$ symbol as HKD, never swallowed by the bare $ pattern", () => {
  const result = extractNativePrice("Patek Nautilus 5711, HK$850,000, full set");
  assert.equal(result?.currency, "HKD");
  assert.equal(result?.amount, 850000);
});

test("extractNativePrice reads EUR and GBP", () => {
  assert.deepEqual(extractNativePrice("AP Royal Oak, EUR95,000"), { amount: 95000, currency: "EUR", originalText: "EUR95,000" });
  assert.deepEqual(extractNativePrice("Submariner, GBP 8,000"), { amount: 8000, currency: "GBP", originalText: "GBP 8,000" });
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

test("required regression: an unknown/unmapped currency still formats with its ISO code, never a wrong symbol", () => {
  assert.equal(formatCurrency(1000000, "JPY"), "1,000,000 JPY");
});
