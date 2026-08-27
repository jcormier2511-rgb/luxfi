import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyText, normalizeText } from "./normalize";

test("classifyText recognizes FS keywords", () => {
  assert.equal(classifyText("FS Rolex Daytona 116500LN $28,000"), "FS");
  assert.equal(classifyText("WTS Patek 5711"), "FS");
  assert.equal(classifyText("For sale: AP Royal Oak"), "FS");
});

test("classifyText recognizes WTB keywords", () => {
  assert.equal(classifyText("WTB Rolex Submariner"), "WTB");
  assert.equal(classifyText("ISO a nice Daytona"), "WTB");
  assert.equal(classifyText("Looking for a Patek 5711"), "WTB");
  assert.equal(classifyText("NTQ on green dial Sub"), "WTB");
});

test("classifyText returns null for plain chatter", () => {
  assert.equal(classifyText("hey how's it going"), null);
  assert.equal(classifyText("thanks!"), null);
});

test("FS keywords take priority when a message somehow matches both", () => {
  // "for sale" wins over an incidental "lf" substring match, matching the FS-checked-first order.
  assert.equal(classifyText("FS Rolex, looking for a quick sale"), "FS");
});

test("normalizeText extracts brand, reference, and price", () => {
  const result = normalizeText("FS Rolex Daytona ref 116500LN, asking $28,500, box and papers");
  assert.equal(result.brand, "rolex");
  assert.equal(result.reference, "116500LN");
  assert.equal(result.price, 28500);
  assert.equal(result.currency, "USD");
});

test("normalizeText handles a post with no structured fields at all", () => {
  const result = normalizeText("WTB looking for a nice watch, any brand");
  assert.equal(result.brand, "");
  assert.equal(result.reference, "");
  assert.equal(result.price, null);
});

test("normalizeText matches brand names case-insensitively and with accents", () => {
  assert.equal(normalizeText("WTB Hermès Birkin").brand, "hermès");
  assert.equal(normalizeText("FS PATEK PHILIPPE 5711").brand, "patek philippe");
});
