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

// Live-reported: "Find a buyer for my rolex 126500LN 2024" and "Find a seller for a rolex
// 126710BLRO" got the generic "I'm not sure I understood that" fallback -- neither BUY_KEYWORDS
// nor SELL_KEYWORDS matched at all, because \bbuy\b/\bsell\b never match inside "buyer"/"seller".
// "Find a buyer" (I HAVE the watch, want it sold) is a sell request; "find a seller" (I want to
// buy FROM one) is a buy request -- the reverse of which keyword you'd naively guess from "find".
test('required regression: "Find a buyer for my rolex 126500LN 2024" is a SELL request, not unrecognized', () => {
  const [item] = parseItemRequests("Find a buyer for my rolex 126500LN 2024");
  assert.ok(item, 'must be classified as an item request');
  assert.equal(item.action, "sell");
  assert.equal(item.query, "rolex 126500LN 2024");
});

test('required regression: "Find a seller for a rolex 126710BLRO" is a BUY request', () => {
  const [item] = parseItemRequests("Find a seller for a rolex 126710BLRO");
  assert.ok(item, 'must be classified as an item request');
  assert.equal(item.action, "buy");
  assert.equal(item.query, "rolex 126710BLRO");
});

test('required regression: "find buyers for my patek 5711" and "find me a seller for a Daytona" are recognized the same way', () => {
  const [sell] = parseItemRequests("find buyers for my patek 5711");
  assert.equal(sell.action, "sell");
  assert.equal(sell.query, "patek 5711");
  const [buy] = parseItemRequests("find me a seller for a Daytona");
  assert.equal(buy.action, "buy");
  assert.equal(buy.query, "Daytona");
});

// Found while auditing more natural phrasings of the same "find a buyer"/"find a seller" report:
// a message asking whether a seller/listing EXISTS ("anyone selling X", "who has X for sale") was
// misread as a SELL request by the plain keyword scan (it contains "selling"/"for sale"), which
// would have opened a for-sale draft -- and could eventually publish a false FS listing -- for
// someone who was actually asking to BUY. The mirror image, "who wants to buy my X" / "any buyers
// for my X", was misread as a BUY request the same way. Both are worse than "unrecognized": a
// silently wrong direction, not just a missed one.
test('required regression: "anyone selling a Rolex Daytona" is a BUY request, not sell', () => {
  const [item] = parseItemRequests("anyone selling a Rolex Daytona");
  assert.equal(item.action, "buy");
});

test('required regression: "who has a Rolex Submariner for sale" is a BUY request, not sell', () => {
  const [item] = parseItemRequests("who has a Rolex Submariner for sale");
  assert.equal(item.action, "buy");
});

test('required regression: "Who wants to buy my Rolex Daytona" is a SELL request, not buy', () => {
  const [item] = parseItemRequests("Who wants to buy my Rolex Daytona");
  assert.equal(item.action, "sell");
});

test('required regression: "Any buyers for my Rolex 116500LN?" is a SELL request', () => {
  const [item] = parseItemRequests("Any buyers for my Rolex 116500LN?");
  assert.equal(item.action, "sell");
});

test('required regression: a genuine sell statement that happens to start with "Any" is never swept in by the reversed-question check -- the sale word must land in the SAME clause as the question word', () => {
  const [item] = parseItemRequests("Any interested buyers, I am selling my Rolex Daytona");
  assert.equal(item.action, "sell");
});

test('required regression: "Hi, I want to join LuxFi network" is never classified as a buy request -- real reported bug: a bare "want" with no explicit command and no product named started an empty WTB draft', () => {
  assert.deepEqual(parseItemRequests("Hi, I want to join LuxFi network"), []);
});

test('a bare command word alone still opens a genuinely broad request, even with no product named: "I am looking for anything"', () => {
  const [item] = parseItemRequests("I am looking for anything");
  assert.equal(item.action, "buy");
  assert.equal(item.query, "anything");
});

test('a soft intent word ("want"/"need") still counts once it names a real product: "I want a Rolex"', () => {
  const [item] = parseItemRequests("I want a Rolex");
  assert.equal(item.action, "buy");
  assert.equal(item.query, "Rolex");
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
