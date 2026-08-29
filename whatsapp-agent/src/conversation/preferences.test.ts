import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePriceRange, parseFreeformPreference } from "./preferences";

test("required: 105.000 USD normalizes to 105000, not 105 (dot-as-thousands-separator)", () => {
  const range = parsePriceRange("105.000 USD");
  assert.ok(range);
  // A bare single value is treated as an approximate target (+/-15%) — the underlying value
  // must be 105000, never 105.
  assert.equal(range!.min, Math.round(105000 * 0.85));
  assert.equal(range!.max, Math.round(105000 * 1.15));
});

test("required: 105,000 USD normalizes to 105000", () => {
  const range = parsePriceRange("105,000 USD");
  assert.equal(range!.min, Math.round(105000 * 0.85));
  assert.equal(range!.max, Math.round(105000 * 1.15));
});

test("required: $105,000 normalizes to 105000", () => {
  const range = parsePriceRange("$105,000");
  assert.equal(range!.min, Math.round(105000 * 0.85));
  assert.equal(range!.max, Math.round(105000 * 1.15));
});

test("required: 105k normalizes to 105000", () => {
  const range = parsePriceRange("105k");
  assert.equal(range!.min, Math.round(105000 * 0.85));
  assert.equal(range!.max, Math.round(105000 * 1.15));
});

test("required: 26.2k normalizes to 26200", () => {
  const range = parsePriceRange("26.2k");
  assert.equal(range!.min, Math.round(26200 * 0.85));
  assert.equal(range!.max, Math.round(26200 * 1.15));
});

test("a real range like $5,000-$8,000 still parses both ends correctly", () => {
  const range = parsePriceRange("$5,000-$8,000");
  assert.equal(range!.min, 5000);
  assert.equal(range!.max, 8000);
});

test("a k-shorthand range like 5k-8k still parses both ends correctly", () => {
  const range = parsePriceRange("5k-8k");
  assert.equal(range!.min, 5000);
  assert.equal(range!.max, 8000);
});

test("a single k suffix applies to both compact range endpoints", () => {
  assert.deepEqual(parsePriceRange("80-100k USD"), { min: 80000, max: 100000 });
  assert.deepEqual(parsePriceRange("80k-100 USD"), { min: 80000, max: 100000 });
  assert.deepEqual(parsePriceRange("80000-100k USD"), { min: 80000, max: 100000 });
});

test("'under 25k' still sets only a max", () => {
  const range = parsePriceRange("under 25k");
  assert.equal(range!.min, undefined);
  assert.equal(range!.max, 25000);
});

test("'maximum', 'budget of', and 'budget is' are exact ceilings, not approximate targets", () => {
  assert.deepEqual(parsePriceRange("maximum 100k"), { max: 100000 });
  assert.deepEqual(parsePriceRange("budget of $100,000"), { max: 100000 });
  assert.deepEqual(parsePriceRange("my budget is $100k"), { max: 100000 });
});

test("'over 5000' still sets only a min", () => {
  const range = parsePriceRange("over 5000");
  assert.equal(range!.min, 5000);
  assert.equal(range!.max, undefined);
});

test("'minimum HKD 100k' sets only the stated minimum", () => {
  assert.deepEqual(parsePriceRange("minimum HKD 100k"), { min: 100000 });
});

test("AUD code and A$ symbol preserve the numeric ceiling", () => {
  assert.deepEqual(parsePriceRange("under AUD 100,000"), { max: 100000 });
  assert.deepEqual(parsePriceRange("under A$100,000"), { max: 100000 });
});

test("US$ prices preserve comparator direction and range endpoints", () => {
  assert.deepEqual(parsePriceRange("under US$100,000"), { max: 100000 });
  assert.deepEqual(parsePriceRange("over US$80,000"), { min: 80000 });
  assert.deepEqual(parsePriceRange("US$80k-US$100k"), { min: 80000, max: 100000 });
});

test("'any' still means no preference", () => {
  assert.equal(parsePriceRange("any"), undefined);
});

test("parseFreeformPreference still treats skip words as no preference", () => {
  assert.equal(parseFreeformPreference("any"), undefined);
  assert.equal(parseFreeformPreference("black"), "black");
});
