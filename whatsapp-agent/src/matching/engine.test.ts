import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR: getActiveListings() merges the group-listings CSV into its DB results
// (see inventoryDb.ts's loadGroupListings), so without this a stray CSV in the repo's real
// ./persist could leak rows into these assertions — same lesson as the postings integration
// tests earlier in this project.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-engine-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("./engine") as typeof import("./engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("../watchfacts/api") as typeof import("../watchfacts/api");
const { upsertListings, _resetDbForTests, _closePoolForTests } = inventoryDb;
const { findMatches, formatMatchCard } = engine;
const { mapToInventoryListings } = api;

after(async () => {
  await _closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

type Row = Parameters<typeof upsertListings>[0][number];

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `item-${id}`,
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    detailUrl: `https://watchfacts.com/flash-sales/${id}`,
    ...overrides,
  };
}

test("a reference-specific search returns only the exact reference — same brand alone is not enough", async () => {
  await _resetDbForTests();
  await upsertListings(
    [
      row("exact", { brand: "Rolex", ref: "116500LN", description: "Rolex Daytona 116500LN" }),
      row("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona 116508-0013 bundle lot" }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "exact");
});

test("a reference-specific search never falls back to an unrelated inventory dump when nothing matches", async () => {
  await _resetDbForTests();
  // A raw, multi-item group-chat dump captured as one noisy "FS listing" — no brand/ref, huge
  // description — exactly the kind of thing that used to surface as a false "match".
  await upsertListings(
    [
      row("noise", {
        item: "New price update!!!!!",
        description:
          "Glory watch READY STOCK 124200 New Blue n8 62k 126000 multicoloured n8 111k Datejust #279171 Choco Roman jub n12 108.5k",
      }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5);
  assert.equal(matches.length, 0, "no live match for the requested reference must return empty, not an unrelated listing");
});

test("reference matching is normalized — formatting differences don't block a real match", async () => {
  await _resetDbForTests();
  // Stored listing has no dash; the search query has one — normalizeReference must still
  // treat these as the same reference.
  await upsertListings([row("a", { brand: "Rolex", ref: "1165080013" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex 116508-0013" }, 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "a");
});

test("required regression: a bare base reference in the query still finds a listing stored with a dial-code suffix", async () => {
  await _resetDbForTests();
  await upsertListings(
    [
      row("exact", { brand: "Rolex", ref: "116500LN", description: "Rolex Daytona 116500LN" }),
      row("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona 116508-0013 bundle lot" }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "buy Rolex 116500" }, 5);
  assert.equal(matches.length, 1, "116500 must still find the 116500LN listing");
  assert.equal(matches[0].id, "exact");
});

test("required regression: a hard maximum price excludes an over-budget listing outright — never shown just because nothing else fits", async () => {
  await _resetDbForTests();
  await upsertListings(
    [row("over-budget", { brand: "Rolex", ref: "116500LN", price: "26200", description: "Rolex Daytona 116500LN" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "buy Rolex Daytona 116500LN" }, 5, { priceMax: 25000 });
  assert.equal(matches.length, 0, "the only candidate is $1,200 over budget and must be excluded, not surfaced anyway");
});

test("required regression: a hard maximum price also excludes an over-budget listing in the broad (no-reference) search branch", async () => {
  await _resetDbForTests();
  await upsertListings([row("over-budget", { brand: "Rolex", price: "26200", description: "Rolex Submariner" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex" }, 5, { priceMax: 25000 });
  assert.equal(matches.length, 0, "must never fall back to the unfiltered pool just because the price filter emptied it");
});

test("a listing within the stated budget still matches normally", async () => {
  await _resetDbForTests();
  await upsertListings(
    [row("in-budget", { brand: "Rolex", ref: "116500LN", price: "24000", description: "Rolex Daytona 116500LN" })],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "buy Rolex Daytona 116500LN" }, 5, { priceMax: 25000 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "in-budget");
});

test("without a reference in the query, matching still falls back to the broader pool as before", async () => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", description: "Rolex Submariner" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex" }, 5);
  assert.equal(matches.length, 1, "brand-only, no-reference searches are unaffected by the strict-reference rule");
});

test('required regression: "under $20000" is never treated as a requested reference', async () => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", description: "Rolex Submariner" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex under $20000" }, 5);
  assert.equal(matches.length, 1, "20000 must be recognized as a price, not force an exact-reference-only search");
});

test("required regression: a stated location is a mandatory pre-filter — a listing outside it is excluded outright, not just ranked lower", async () => {
  await _resetDbForTests();
  await upsertListings(
    [
      row("us-listing", { brand: "Rolex", ref: "116500LN", location: "North America", description: "Rolex Daytona 116500LN" }),
      row("hk-listing", { brand: "Rolex", ref: "116500LN", location: "Asia", description: "Rolex Daytona 116500LN" }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { location: "USA" });
  assert.equal(matches.length, 1, "the Asia listing must be excluded outright for a stated USA requirement");
  assert.equal(matches[0].id, "us-listing");
});

test("required regression: 'USA' matches the stored 'North America' region (WatchFacts only gives continent-level location)", async () => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN", location: "North America", description: "Rolex Daytona 116500LN" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { location: "US" });
  assert.equal(matches.length, 1, "'US' must resolve to the same region bucket as the stored 'North America'");
});

test("a listing with no location on file is excluded when a location is explicitly required — never assumed to match", async () => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN", location: "", description: "Rolex Daytona 116500LN" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { location: "USA" });
  assert.equal(matches.length, 0, "an unverifiable location can't be presented as satisfying a stated requirement");
});

test("without a stated location preference, matching is unaffected regardless of the listing's location", async () => {
  await _resetDbForTests();
  await upsertListings([row("a", { brand: "Rolex", ref: "116500LN", location: "Asia", description: "Rolex Daytona 116500LN" })], new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5);
  assert.equal(matches.length, 1, "no location constraint was stated, so nothing should be excluded on location grounds");
});

test("required regression: a bundle of several watches returns only the one matching structured watch", async () => {
  await _resetDbForTests();
  // Same shape as a real WatchFacts bundle sale — mapToInventoryListings (api.ts) maps each
  // sub-listing individually, exactly as syncInventory.ts would upsert them.
  const bundleSale: Parameters<typeof mapToInventoryListings>[0] = {
    id: "bundle-1",
    isBundle: true,
    title: "Mixed lot",
    status: "open",
    price: 500000,
    deadline: "2999-01-01 00:00:00",
    listings: [
      { id: "d1", brand: "Rolex", model: null, reference: "116500LN", normalizedReference: null, title: "Daytona", condition: "New", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "d2", brand: "Rolex", model: null, reference: "126710BLRO", normalizedReference: null, title: "GMT-Master II", condition: "New", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "d3", brand: "Patek Philippe", model: null, reference: "5711", normalizedReference: null, title: "Nautilus", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
    ],
    companyName: "Bundle Dealer",
    fromName: null,
    companyStars: null,
    whatsappNumber: "10000000000",
    companyWhatsapp: null,
    region: "Asia",
  };
  await upsertListings(mapToInventoryListings(bundleSale, "FS"), new Date().toISOString());

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5);
  assert.equal(matches.length, 1, "only the one sub-listing matching the requested reference should come back");
  assert.equal(matches[0].ref, "116500LN");
});

test("required regression: a WatchFacts 'single' listing whose own description is a multi-item price-list dump is never surfaced, even when its structured ref/price would otherwise match", async () => {
  await _resetDbForTests();
  // Mirrors the live bug report: a dealer "PRICE UPDATE" blast came back from the WatchFacts API
  // as one row (empty listings[], so mapToInventoryListings trusted sale.price directly) whose
  // OWN reference/price happened to line up with the request, but whose description names many
  // other watches at wildly different prices — the signature of a bundle blast, not one listing.
  await upsertListings(
    [
      row("bundle-blast", {
        brand: "Rolex",
        ref: "116500LN",
        price: "24000",
        item: "PRICE UPDATE",
        description:
          "PRICE UPDATE: Daytona 116500LN $63,000, GMT 126710 $28,000, Sub 126610 $18,000, Nautilus 5711 $660,000",
      }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 27000 });
  assert.equal(matches.length, 0, "a listing whose description names many distinct prices must never be surfaced as a single match");
});

test("required regression: an overseas dealer price sheet with no $ signs (currency codes like hkd instead) is also excluded as a bundle blast", async () => {
  await _resetDbForTests();
  // The actual reported live bug: a Hong Kong dealer's whole price list, written as
  // "hkd210k" rather than "$210k" — must still be recognized as a multi-item dump.
  await upsertListings(
    [
      row("hk-dump", {
        brand: "Rolex",
        ref: "116500LN",
        price: "24000",
        item: "cinly rolex",
        description:
          "116500ln white 2011 hkd210k\n116500ln white 2018 hkd233k\n116520 black 2010 hkd167k\n116523g white panda 2012 hkd145k",
      }),
    ],
    new Date().toISOString()
  );

  const matches = await findMatches({ action: "buy", query: "Rolex Daytona 116500LN" }, 5, { priceMax: 27000 });
  assert.equal(matches.length, 0, "a currency-code (non-$) price dump must be excluded exactly like a $-denominated one");
});

test("required regression: a WatchFacts match card names the exact reference, price/ASK, location, source, and listing URL", () => {
  const listing = {
    id: "sale-1",
    type: "FS" as const,
    category: "watches",
    item: "Rolex Daytona 116500LN white dial",
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "28500",
    location: "North America",
    contactName: "Marco D.",
    contactPhone: "15551234567",
    source: "WF",
    rating: "4",
    description: "Rolex Daytona 116500LN white dial",
    detailUrl: "https://watchfacts.com/flash-sales/sale-1",
  };
  const card = formatMatchCard(listing, 0, "buy");
  assert.match(card, /116500LN/, "the exact reference must appear on the card");
  assert.match(card, /\$28,500/, "the price must appear on the card, comma-formatted");
  assert.match(card, /North America/);
  assert.match(card, /Source: WatchFacts/);
  assert.match(card, /https:\/\/watchfacts\.com\/flash-sales\/sale-1/);
});

test("required regression: the card always includes a Description field with the verbatim stored source text, distinct from the normalized Watch title", () => {
  const listing = {
    id: "sale-3",
    type: "FS" as const,
    category: "watches",
    item: "Rolex Daytona 116500LN",
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "26200",
    location: "North America",
    contactName: "Dealer",
    contactPhone: "123",
    source: "WF",
    rating: "",
    description: "Rolex HK stock, Daytona 116500LN blk $433,000hkd 6/2026, box and papers",
    detailUrl: "https://watchfacts.com/flash-sales/sale-3",
  };
  const card = formatMatchCard(listing, 0, "buy");
  assert.match(card, /Description: Rolex HK stock, Daytona 116500LN blk \$433,000hkd 6\/2026, box and papers/);
});

test("the card reports 'Not provided' rather than an empty Description line when no source text exists", () => {
  const listing = {
    id: "sale-4",
    type: "FS" as const,
    category: "watches",
    item: "Rolex Daytona 116500LN",
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "26200",
    location: "",
    contactName: "",
    contactPhone: "",
    source: "WF",
    rating: "",
    description: "",
  };
  const card = formatMatchCard(listing, 0, "buy");
  assert.match(card, /Description: Not provided/);
});

test("required regression: an ASK-priced listing's card never invents a price", () => {
  const listing = {
    id: "sale-2",
    type: "FS" as const,
    category: "watches",
    item: "Patek Nautilus 5711",
    brand: "Patek Philippe",
    ref: "5711",
    condition: "Used",
    price: "ASK",
    location: "",
    contactName: "",
    contactPhone: "",
    source: "WF",
    rating: "",
    description: "Patek Nautilus 5711",
  };
  const card = formatMatchCard(listing, 0, "buy");
  assert.match(card, /price on ask/i);
  assert.doesNotMatch(card, /\$ASK/);
});
