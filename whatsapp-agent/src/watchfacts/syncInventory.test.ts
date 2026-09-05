import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { RawFlashSale } from "./api";
import type { SourceDb } from "./sourceDb";

// Must be set before config.ts (and therefore inventoryDb.ts) is first required — see the
// same note in inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// The postings-mirror regression test below needs the v4 mirror step to actually run.
process.env.ENABLE_V4_POSTINGS = "true";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("./api") as typeof import("./api");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncOneSide, fetchOpenAuctionsFromDb } = require("./syncInventory") as typeof import("./syncInventory");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scoreMatch } = require("../postings/matching") as typeof import("../postings/matching");

after(() => {
  inventoryDb._closePoolForTests();
  db._closePoolForTests();
});

function fakeSale(id: string): RawFlashSale {
  return {
    id,
    isBundle: false,
    title: "Rolex Daytona 116500LN",
    status: "open",
    price: 18500,
    deadline: "2999-01-01 00:00:00",
    listings: [],
    companyName: "Marco D.",
    fromName: null,
    companyStars: 4,
    whatsappNumber: "15551234567",
    companyWhatsapp: null,
    region: "North America",
  };
}

test("syncOneSide: a WTB failure never touches FS's already-saved data or status", async (t) => {
  await inventoryDb._resetDbForTests();

  t.mock.method(api, "fetchAllFlashSales", async (_page: Page, auctionType: string) => {
    if (auctionType === "sale") return [fakeSale("fs-real-1")];
    throw new Error("this mock should never be called with a non-'sale' auctionType in this test");
  });

  const dummyPage = {} as Page;
  const now = new Date();

  const fsResult = await syncOneSide(dummyPage, "FS", "sale", now);
  assert.equal(fsResult.count, 1);
  assert.equal(fsResult.error, undefined);

  const wtbResult = await syncOneSide(
    dummyPage,
    "WTB",
    async () => {
      throw new Error("Could not find a working auction_type value for WTB");
    },
    now
  );
  assert.equal(wtbResult.count, 0);
  assert.match(wtbResult.error ?? "", /auction_type/);

  // The real assertion: FS's upsert actually happened and is unaffected by WTB's failure.
  const fsListings = await inventoryDb.getActiveListings("FS");
  assert.equal(fsListings.length, 1);
  assert.equal(fsListings[0].id, "fs-real-1");

  const status = await inventoryDb.getSyncStatus(true);
  assert.ok(status.fs.lastSuccessAt, "FS should show a successful sync");
  assert.equal(status.fs.lastError, null);
  assert.equal(status.wtb.lastSuccessAt, null);
  assert.match(status.wtb.lastError ?? "", /auction_type/);
});

test("syncOneSide: an FS failure never touches WTB's already-saved data or status", async (t) => {
  await inventoryDb._resetDbForTests();

  t.mock.method(api, "fetchAllFlashSales", async (_page: Page, auctionType: string) => {
    if (auctionType === "wtb") return [fakeSale("wtb-real-1")];
    throw new Error("simulated FS fetch failure");
  });

  const dummyPage = {} as Page;
  const now = new Date();

  const fsResult = await syncOneSide(dummyPage, "FS", "sale", now);
  assert.equal(fsResult.count, 0);
  assert.ok(fsResult.error);

  const wtbResult = await syncOneSide(dummyPage, "WTB", "wtb", now);
  assert.equal(wtbResult.count, 1);
  assert.equal(wtbResult.error, undefined);

  const wtbListings = await inventoryDb.getActiveListings("WTB");
  assert.equal(wtbListings.length, 1);

  const status = await inventoryDb.getSyncStatus(true);
  assert.ok(status.wtb.lastSuccessAt);
  assert.equal(status.wtb.lastError, null);
  assert.ok(status.fs.lastError);
});

test("required regression: a WatchFacts FS listing's dial/model/location reach the postings mirror, so a dial-specific WTB can actually match it", async (t) => {
  await inventoryDb._resetDbForTests();
  await db._resetDbForTests();

  t.mock.method(api, "fetchAllFlashSales", async (_page: Page, auctionType: string) => {
    if (auctionType !== "sale") throw new Error("this test only exercises the FS side");
    return [
      {
        ...fakeSale("wf-daytona-1"),
        title: "Rolex Daytona 116500LN",
        listings: [
          {
            id: "wf-daytona-1",
            brand: "Rolex",
            model: "Daytona",
            reference: "116500LN",
            normalizedReference: null,
            title: "Rolex Daytona 116500LN",
            condition: "Used",
            frontImage: null,
            box: "Yes",
            papers: "Yes",
            dialColor: "Black",
          },
        ],
      },
    ];
  });

  const dummyPage = {} as Page;
  const fsResult = await syncOneSide(dummyPage, "FS", "sale", new Date());
  assert.equal(fsResult.count, 1);
  assert.equal(fsResult.error, undefined);

  const mirrored = await db.withSchema((pool) => pool.query(`SELECT * FROM postings WHERE external_listing_id=$1`, ["wf-daytona-1"]));
  assert.equal(mirrored.rows.length, 1);
  const fsPosting = mirrored.rows[0];
  assert.equal(fsPosting.dial, "Black", "the dial WatchFacts reported must reach the postings mirror, not stay blank");
  assert.equal(fsPosting.model, "Daytona");
  assert.equal(fsPosting.location, "North America");

  // The real reported bug: a WTB naming a specific dial color always rejected a WatchFacts FS
  // listing because fs.dial was permanently "" — reproduce that exact WTB shape here and
  // confirm scoreMatch now finds it.
  const wtbPosting = { ...fsPosting, reference: "116500LN", dial: "black", condition: "", location: "" };
  const result = scoreMatch(fsPosting, wtbPosting);
  assert.ok(result, "a dial-specific WTB must be able to match a WatchFacts FS listing once its dial actually reaches the postings table");
});

test("required regression: fetchOpenAuctionsFromDb carries auctions.number through as publicId — the real reported bug was every DB-synced listing's link 500ing on the actual site because it was built from auctions.id (an internal UUID) instead", async () => {
  const fakeDb: SourceDb = {
    dialect: "mysql",
    tls: "off",
    query: async () => [
      {
        id: "9fd0c621-53e6-466f-9481-ebd852682c3f",
        number: 9180837,
        is_bundle: 0,
        title: "116500ln black Daytona 40mm w&c full links 2017 $25,000",
        status: "open",
        price: "25000.00",
        deadline: "2026-09-06 21:01:30",
        brand: null,
        model: null,
        reference: null,
        normalized_reference: null,
        condition_id: 6,
        front_image: "6a94d26a494f9_front_image.jpg",
        box: "No",
        papers: "Yes",
        dial_color: null,
        from_name: "Eli Gamzo - wholesale",
        from_number: "12134492911",
        dealer_rating: null,
        region: "North America",
      },
    ],
    close: async () => undefined,
  } as unknown as SourceDb;

  const [auction] = await fetchOpenAuctionsFromDb(fakeDb, "sale");
  assert.equal(auction.id, "9fd0c621-53e6-466f-9481-ebd852682c3f", "the internal id is still used for our own dedup/matching key");
  assert.equal(auction.publicId, "9180837", "auctions.number must be carried through so the link the site actually serves gets built");
});
