import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyText, normalizeText, normalizeReference, extractReference, referencesMatch } from "./normalize";

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

test("normalizeText returns null price when the message names more than one distinct $ amount", () => {
  // A multi-item price-list dump — no way to know which price belongs to which item, so this
  // must never guess by picking the first one.
  const result = normalizeText("READY STOCK: 124200 New Blue $62,000, 126000 multicoloured $111,000");
  assert.equal(result.price, null);
});

test("normalizeText still extracts a price when the same amount is mentioned more than once", () => {
  const result = normalizeText("FS Rolex Daytona 116500LN $28,500 — firm at $28,500, no lowballs");
  assert.equal(result.price, 28500);
});

test("normalizeReference strips formatting and uppercases for comparison", () => {
  assert.equal(normalizeReference("116508-0013"), "1165080013");
  assert.equal(normalizeReference("116500ln"), "116500LN");
  assert.equal(normalizeReference(" 126710 BLRO "), "126710BLRO");
});

test("normalizeReference makes differently-formatted references compare equal, and different ones stay different", () => {
  assert.equal(normalizeReference("116500-LN"), normalizeReference("116500ln"));
  assert.notEqual(normalizeReference("116500LN"), normalizeReference("116508-0013"));
});

test('required regression: extractReference never treats a $-prefixed price as a reference', () => {
  assert.equal(extractReference("WTB Rolex under $20000"), null);
  assert.equal(extractReference("WTB Rolex under $ 20000"), null); // space between $ and the amount
  assert.equal(extractReference("FS Rolex Daytona 116500LN, asking $28500"), "116500LN", "a real reference elsewhere in the text must still be found");
});

test("normalizeText never captures a $-prefixed price as the reference field", () => {
  const result = normalizeText("WTB Rolex under $20000");
  assert.equal(result.reference, "");
});

test("required regression: extractReference handles references with periods and chained separators", () => {
  assert.equal(extractReference("Patek Nautilus 3510.50"), "3510.50");
  assert.equal(extractReference("Patek 5712/1A-001 steel"), "5712/1A-001");
});

test("referencesMatch: a bare base reference matches a suffixed variant of the same watch", () => {
  assert.ok(referencesMatch("116500", "116500LN"));
  assert.ok(referencesMatch("116500LN", "116500")); // order-independent
});

test("required regression: referencesMatch never matches a different reference sharing a digit prefix", () => {
  assert.equal(referencesMatch("116500", "116508"), false);
  assert.equal(referencesMatch("116500LN", "116508-0013"), false);
});

test("referencesMatch still requires exact equality once both sides are fully specified", () => {
  assert.ok(referencesMatch("116508-0013", "1165080013")); // formatting-only difference
  assert.equal(referencesMatch("116500LN", "116500LV"), false); // different dial code, same length
});
