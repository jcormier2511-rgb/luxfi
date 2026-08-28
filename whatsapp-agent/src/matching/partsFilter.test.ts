import { test } from "node:test";
import assert from "node:assert/strict";
import { isPartsOrAccessoryListing } from "./partsFilter";

test("required regression: a bezel-led listing (the live bug's exact case) is flagged as a part, not a watch", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "Ceramic Bezel $2500+. Shipped" }), true);
});

test("a listing whose title leads with the brand and reference is never flagged, even if it later mentions a part", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "Rolex Daytona 116500LN Ceramic Bezel Full Set" }), false);
});

test("a dial-color-first complete-watch title is never flagged when a reference is named that early", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "White Dial Daytona 116500LN, box and papers" }), false);
});

test("a title naming a reference within its first four words is a complete watch even when a dial color leads", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "Champagne Dial Datejust 16233 Full Set" }), false);
});

test("a genuine dial-only or bracelet-only sale is flagged when no reference is named that early", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "Champagne Dial Only, fits Datejust 16233" }), true);
  assert.equal(isPartsOrAccessoryListing({ item: "Steel Bracelet for Rolex Submariner" }), true);
});

test("an empty title is never flagged", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "" }), false);
});

test("a plain watch title with no part keyword at all is never flagged", () => {
  assert.equal(isPartsOrAccessoryListing({ item: "Patek Philippe Nautilus 5711/1A-010" }), false);
});
