import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyText,
  normalizeText,
  normalizeReference,
  extractReference,
  referencesMatch,
  normalizePriceShorthand,
  hasMultipleDistinctPrices,
  canonicalizeReference,
  referenceEquivalents,
  isOnlyIntentLanguage,
  isOnlyNonModelLanguage,
  splitLeadingBrand,
} from "./normalize";

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

test("required regression: explicit buying language wins even when stock/for-sale language also appears in the same message", () => {
  // Reverses the earlier FS-checked-first tie-break: a buyer's own explicit signal (WTB/
  // wanted/looking for/need/buying/ISO) describes what they want more reliably than an
  // incidental "for sale"/"FS" elsewhere in the same messy dealer-group post.
  assert.equal(classifyText("FS Rolex, looking for a quick sale"), "WTB");
  assert.equal(classifyText("READY STOCK available, but WTB a green dial Sub too"), "WTB");
});

test("required regression: stock/availability language classifies as FS, the same as an explicit for-sale keyword", () => {
  assert.equal(classifyText("READY STOCK: Daytona 116500LN $63,000"), "FS");
  assert.equal(classifyText("In stock now: Nautilus 5711 $105,000"), "FS");
  assert.equal(classifyText("Available: GMT-Master 126710BLRO"), "FS");
});

test("required regression: a dealer inventory list with no explicit FS/WTB keyword still classifies as FS, never left unclassified", () => {
  // Real reported case: a Hong Kong dealer's whole price sheet, no "for sale"/"FS"/"ready
  // stock" spelled out anywhere, but clearly a listing (has prices and references) — dropping
  // this silently would mean real inventory never gets ingested at all.
  const dump = "116500ln white 2011 hkd210k\n116520 black 2010 hkd167k\n116523g white panda 2012 hkd145k";
  assert.equal(classifyText(dump), "FS");
});

test("classifyText still returns null for plain chatter even though it now has a price/reference fallback", () => {
  assert.equal(classifyText("hey how's it going"), null);
  assert.equal(classifyText("thanks!"), null);
  assert.equal(classifyText("good morning everyone"), null);
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

test("required regression: normalizePriceShorthand treats 25.5, 25,5, and 25.5k as the same amount", () => {
  assert.equal(normalizePriceShorthand("25.5"), 25500);
  assert.equal(normalizePriceShorthand("25,5"), 25500);
  assert.equal(normalizePriceShorthand("25.5k"), 25500);
  assert.equal(normalizePriceShorthand("$25.5k"), 25500);
});

test("normalizePriceShorthand leaves a real thousands-separated amount and a legitimate small integer alone", () => {
  assert.equal(normalizePriceShorthand("26,200"), 26200);
  assert.equal(normalizePriceShorthand("$26,200"), 26200);
  assert.equal(normalizePriceShorthand("1,234,567"), 1234567);
  assert.equal(normalizePriceShorthand("500"), 500, "a bare whole integer is a literal amount, not shorthand for 500,000");
});

test("required regression: normalizePriceShorthand fixes the exact reported bug — a truncated $26.2 becomes $26,200, not $26.20", () => {
  assert.equal(normalizePriceShorthand("$26.2"), 26200);
});

test("normalizePriceShorthand takes only the FIRST currency when several are mentioned together", () => {
  assert.equal(normalizePriceShorthand("25,5usd/35,4cad"), 25500);
  assert.equal(normalizePriceShorthand("26200hkd/23800hkd"), 26200);
});

test("normalizePriceShorthand returns null for text with no number in it", () => {
  assert.equal(normalizePriceShorthand("price on ask"), null);
  assert.equal(normalizePriceShorthand(""), null);
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

test("required regression: hasMultipleDistinctPrices flags a multi-item dealer price-list dump", () => {
  const dump =
    "PRICE UPDATE: Daytona 116500LN $63,000, GMT 126710 $28,000, Sub 126610 $18,000, Nautilus 5711 $660,000";
  assert.equal(hasMultipleDistinctPrices(dump), true);
});

test("hasMultipleDistinctPrices returns false for a single-item listing, including one that repeats its own price", () => {
  assert.equal(hasMultipleDistinctPrices("FS Rolex Daytona 116500LN, asking $28,500"), false);
  assert.equal(hasMultipleDistinctPrices("FS Rolex Daytona 116500LN $28,500 — firm at $28,500, no lowballs"), false);
});

test("hasMultipleDistinctPrices returns false for text with no price at all", () => {
  assert.equal(hasMultipleDistinctPrices("WTB looking for a nice watch, any brand"), false);
  assert.equal(hasMultipleDistinctPrices(""), false);
});

test("required regression: hasMultipleDistinctPrices catches a currency-code price dump with no $ sign at all (the reported live bug)", () => {
  // Real reported case: an overseas dealer's whole price sheet, prices written as "hkd210k"
  // rather than "$210k" — the original $-only pattern never even saw these as prices.
  const dump =
    "116500ln white 2011 hkd210k\n116500ln white 2018 hkd233k\n116520 black 2010 hkd167k\n116523g white panda 2012 hkd145k";
  assert.equal(hasMultipleDistinctPrices(dump), true);
});

test("normalizePriceShorthand handles a currency-code-prefixed amount with no $ sign", () => {
  assert.equal(normalizePriceShorthand("hkd210k"), 210000);
  assert.equal(normalizePriceShorthand("HKD 233k"), 233000);
  assert.equal(normalizePriceShorthand("usd25000"), 25000);
});

test("reference canonicalization is an explicit alias table, not a suffix guess", () => {
  // A bare stem aliases to a suffixed reference ONLY where that stem has exactly one produced
  // variant, so the shorthand cannot mean anything else.
  assert.equal(canonicalizeReference("116500"), "116500LN");
  assert.equal(canonicalizeReference(" 116500ln "), "116500LN");
  assert.equal(canonicalizeReference("116500-LN"), "116500LN");
  assert.equal(canonicalizeReference("126500"), "126500LN");
  // 116610 is genuinely ambiguous (116610LN black, 116610LV green) and must never be rewritten,
  // and no unrelated reference is touched either.
  assert.equal(canonicalizeReference("116610"), "116610");
  assert.equal(canonicalizeReference("116610LV"), "116610LV");
  assert.equal(canonicalizeReference("5711/1A"), "5711/1A");
  assert.equal(canonicalizeReference("   "), "");
});

test("reference equivalents cover every stored form of the same watch", () => {
  assert.deepEqual(referenceEquivalents("116500").sort(), ["116500", "116500LN"]);
  assert.deepEqual(referenceEquivalents("116500LN").sort(), ["116500", "116500LN"]);
  assert.deepEqual(referenceEquivalents("116610LV"), ["116610LV"]);
  assert.deepEqual(referenceEquivalents("116508-0013"), ["1165080013"]);
});

test("intent language is recognized as carrying no identity", () => {
  for (const phrase of ["", ",", "i want ot buy a", "ot buy a", "looking for", "wtb", "a", "to buy"]) {
    assert.equal(isOnlyIntentLanguage(phrase), true, `"${phrase}" should be intent-only`);
  }
  for (const phrase of ["daytona", "white", "submariner date", "5711"]) {
    assert.equal(isOnlyIntentLanguage(phrase), false, `"${phrase}" should be a real identity`);
  }
});

test("a leading maker name is split off a market-pulse argument", () => {
  assert.deepEqual(splitLeadingBrand("Rolex 116500LN"), { brand: "rolex", rest: "116500LN" });
  assert.deepEqual(splitLeadingBrand("patek philippe 5711/1A"), { brand: "patek philippe", rest: "5711/1A" });
  assert.deepEqual(splitLeadingBrand("116500LN"), { brand: null, rest: "116500LN" });
});

test("a phrase of pure descriptors names no model, but a model built from them survives", () => {
  // Dial colors and condition words describe a watch; they never identify its model.
  for (const phrase of ["black", "white dial", "pre-owned", "black dial", "any", "either", ","]) {
    assert.equal(isOnlyNonModelLanguage(phrase), true, `"${phrase}" should name no model`);
  }
  // Whole-phrase judgement only — individual descriptor words are never removed, so real models
  // built out of them are kept intact.
  for (const phrase of ["black bay", "daytona", "speedmaster professional", "royal oak"]) {
    assert.equal(isOnlyNonModelLanguage(phrase), false, `"${phrase}" is a real model`);
  }
});
