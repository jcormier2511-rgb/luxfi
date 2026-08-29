import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { RawFlashSale } from "./api";

// Must be set before config.ts (and therefore inventoryDb.ts) is first required — see the
// same note in inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = require("./api") as typeof import("./api");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncOneSide, v4PriceFields } = require("./syncInventory") as typeof import("./syncInventory");

after(() => inventoryDb._closePoolForTests());

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


test("v4PriceFields keeps unreliable bundle prices as ASK", () => {
  assert.deepEqual(
    v4PriceFields({ price: "ASK", nativePriceAmount: 100000, nativeCurrency: "USD" }),
    { price: "ASK", currency: "USD" }
  );
  assert.deepEqual(
    v4PriceFields({ price: "15000000", nativePriceAmount: 15000000, nativeCurrency: "JPY" }),
    { price: "15000000", currency: "JPY" }
  );
});
