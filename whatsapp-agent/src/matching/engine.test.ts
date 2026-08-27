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
const { findMatches } = engine;
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
