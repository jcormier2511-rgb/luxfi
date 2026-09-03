import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseItemRequests, stripLeadingIntent } = require("./flow") as typeof import("./flow");

test("required: 'Do not store phrases such as \"to buy a patek 5712G\"' — the legacy parser must strip the FULL lead-in, not just one word", () => {
  const [item] = parseItemRequests("want to buy a patek 5712G");
  assert.equal(item.action, "buy");
  assert.equal(item.query, "patek 5712G");
  assert.doesNotMatch(item.query, /^to\b/i);
});

test("required: 'I want to buy a Patek 5712' strips the entire lead-in", () => {
  const [item] = parseItemRequests("I want to buy a Patek 5712");
  assert.equal(item.action, "buy");
  assert.equal(item.query, "Patek 5712");
});

test("required: 'I want to sell a Patek 5712' never stores 'i want to sell a patek 5712' as the item", () => {
  const [item] = parseItemRequests("I want to sell a Patek 5712");
  assert.equal(item.action, "sell");
  assert.equal(item.query, "Patek 5712");
  assert.doesNotMatch(item.query, /\bsell\b/i);
  assert.doesNotMatch(item.query, /\bi want\b/i);
});

test("required: 'Looking for a black Daytona under 25k in the US' strips 'Looking for'", () => {
  const [item] = parseItemRequests("Looking for a black Daytona under 25k in the US");
  assert.equal(item.action, "buy");
  assert.equal(item.query, "black Daytona under 25k in the US");
});

const BUY_PHRASINGS: [string, string][] = [
  ["Looking for a Rolex Daytona", "buy"],
  ["I need a Rolex Daytona", "buy"],
  ["find me a Rolex Daytona", "buy"],
  ["ISO Rolex Daytona", "buy"],
  ["WTB Rolex Daytona", "buy"],
];

for (const [text, action] of BUY_PHRASINGS) {
  test(`required keyword recognized: "${text}"`, () => {
    const [item] = parseItemRequests(text);
    assert.ok(item, `"${text}" must be classified as an item request`);
    assert.equal(item.action, action);
    assert.equal(item.query, "Rolex Daytona");
  });
}

test('required keyword recognized: "for sale: Rolex Daytona"', () => {
  const [item] = parseItemRequests("for sale: Rolex Daytona");
  assert.equal(item.action, "sell");
  assert.equal(item.query, "Rolex Daytona");
});

test('required keyword recognized: "I have a Rolex Daytona"', () => {
  const [item] = parseItemRequests("I have a Rolex Daytona");
  assert.equal(item.action, "sell");
  assert.equal(item.query, "Rolex Daytona");
});

test('required keyword recognized: "selling: Hermes Birkin"', () => {
  const [item] = parseItemRequests("selling: Hermes Birkin");
  assert.equal(item.action, "sell");
  assert.equal(item.query, "Hermes Birkin");
});

test("stripLeadingIntent handles a bare reference with no lead-in at all", () => {
  assert.equal(stripLeadingIntent("Rolex Daytona 116500LN"), "Rolex Daytona 116500LN");
});

test("stripLeadingIntent strips a leading article after the intent phrase", () => {
  assert.equal(stripLeadingIntent("want to buy an Omega Speedmaster"), "Omega Speedmaster");
});

// ---------------------------------------------------------------------------------------------
// Multi-item detection is decided by product identity, never by conjunctions or intent words.
// Live Stage 1 failure: "…116500LN with a black dial. I'm in Miami and don't want to spend more
// than $25,000" split at "and", "don't WANT" read as a second buy, one watch became two.
// ---------------------------------------------------------------------------------------------

test("a clause joined by 'and' with no product of its own continues the item, it does not open a second one", () => {
  const items = parseItemRequests("I'm looking for a pre-owned Rolex Daytona 116500LN with a black dial. I'm in Miami and don't want to spend more than $25,000.");
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "buy");
  assert.match(items[0].query, /^pre-owned Rolex Daytona 116500LN with a black dial\. I'm in Miami and don't want to spend more than \$25,000$/, "the folded query keeps the author's own text, not a comma list");
});

test("intent words alone never open a second item", () => {
  assert.equal(parseItemRequests("WTB Rolex 116500LN, and I need it pre-owned, and I want to spend under 25k").length, 1);
  assert.equal(parseItemRequests("Looking for a 116500LN black dial and pre-owned, Miami, up to 25k").length, 1);
});

test("a second segment that names its own product IS a second item", () => {
  const two = parseItemRequests("I'm looking for a Rolex 116500LN and a Patek 5712G.");
  assert.deepEqual(two.map((i) => i.query), ["Rolex 116500LN", "Patek 5712G"]);
});

test("later products inherit the intent of the request that introduced them", () => {
  const three = parseItemRequests("Need these three: 116500LN, 126710BLRO, 5712G.");
  assert.equal(three.length, 3);
  assert.deepEqual(three.map((i) => i.action), ["buy", "buy", "buy"]);
  assert.deepEqual(three.slice(1).map((i) => i.query), ["126710BLRO", "5712G"]);
});

test("details strung together with commas stay one item", () => {
  assert.ok(parseItemRequests("WTB Rolex Daytona 116500LN, black dial, pre-owned, Miami, max $25k.").length === 1);
});
