import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-photorequests-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const photoRequests = require("./photoRequests") as typeof import("./photoRequests");

const { upsertListings, _resetDbForTests, _closePoolForTests, getPhotoRequestRecord } = inventoryDb;
const { requestPhotosForMatch, handleIncomingSellerPhoto } = photoRequests;

after(async () => {
  await _closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

type Row = Parameters<typeof upsertListings>[0][number];
const REQUESTER_PHONE = "19995551111";
const SELLER_PHONE = "18885552222";

function sellerRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `Rolex Daytona 116500LN item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "28000",
    location: "North America",
    contactName: "Marco D.",
    contactPhone: SELLER_PHONE,
    rating: "4",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

async function seedListing(id: string, overrides: Partial<Row> = {}) {
  await _resetDbForTests();
  await upsertListings([sellerRow(id, overrides)], new Date().toISOString());
  return { ...sellerRow(id, overrides), source: "WF" };
}

test("photos request resolves the correct match and privately messages the seller, never revealing the requester's number", async (t) => {
  const listing = await seedListing("photo-1");
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const outcome = await requestPhotosForMatch(REQUESTER_PHONE, listing, 1);
  assert.equal(outcome, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, SELLER_PHONE, "the request must go to the seller, not the requester");
  assert.doesNotMatch(sent[0].message, new RegExp(REQUESTER_PHONE), "the seller must never see the requester's phone number");
  assert.match(sent[0].message, /Please reply with 3–6 clear photos/);

  const record = await getPhotoRequestRecord(listing.source, listing.type, listing.id);
  assert.equal(record?.status, "requested");
  assert.equal(record?.requesterPhone, REQUESTER_PHONE);
  assert.equal(record?.matchId, "1");
});

test("duplicate protection: a second photo request on the same match within 48 hours is suppressed", async (t) => {
  const listing = await seedListing("photo-2");
  let sendCount = 0;
  t.mock.method(whapiClient, "sendText", async () => {
    sendCount++;
  });

  const first = await requestPhotosForMatch(REQUESTER_PHONE, listing, 1);
  const second = await requestPhotosForMatch("19995559999", listing, 1);

  assert.equal(first, "sent");
  assert.equal(second, "duplicate");
  assert.equal(sendCount, 1, "the seller must only ever be messaged once for the still-open request");
});

test("a listing with no seller contact number is reported unavailable rather than left as a silent no-op", async (t) => {
  const listing = await seedListing("photo-3", { contactPhone: "" });
  let sendCount = 0;
  t.mock.method(whapiClient, "sendText", async () => {
    sendCount++;
  });

  const outcome = await requestPhotosForMatch(REQUESTER_PHONE, listing, 1);
  assert.equal(outcome, "unavailable");
  assert.equal(sendCount, 0);
});

test("required: the seller's photos are routed to the correct requester and privately forwarded, with neither phone number leaked", async (t) => {
  const listing = await seedListing("photo-5");
  const toSeller: string[] = [];
  const toRequester: { phone: string; imageUrl: string }[] = [];
  const textToRequester: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    if (phone === SELLER_PHONE) toSeller.push(message);
    else textToRequester.push({ phone, message });
  });
  t.mock.method(whapiClient, "sendBannerImage", async (phone: string, imageUrl: string) => {
    toRequester.push({ phone, imageUrl });
  });

  await requestPhotosForMatch(REQUESTER_PHONE, listing, 1);

  const handled = await handleIncomingSellerPhoto(SELLER_PHONE, "https://cdn.example/img1.jpg");
  assert.equal(handled, true);
  assert.equal(toRequester.length, 1);
  assert.equal(toRequester[0].phone, REQUESTER_PHONE, "photos must be forwarded to the original requester");
  assert.equal(toRequester[0].imageUrl, "https://cdn.example/img1.jpg");

  const summary = textToRequester.find((m) => /Potential Match/.test(m.message));
  assert.ok(summary, "the match summary must be resent once photos arrive");
  assert.doesNotMatch(summary!.message, new RegExp(SELLER_PHONE), "the resent summary must never leak the seller's phone number");
  assert.match(summary!.message, /photos <number>/, "the resent summary keeps the approve\\/photos\\/pass options");

  const record = await getPhotoRequestRecord(listing.source, listing.type, listing.id);
  assert.equal(record?.status, "received");
  assert.equal(record?.photos.length, 1);
});

test("every photo in a multi-image reply is forwarded, but the match summary is only resent once", async (t) => {
  const listing = await seedListing("photo-6");
  let bannerCount = 0;
  let summaryCount = 0;
  t.mock.method(whapiClient, "sendText", async (_phone: string, message: string) => {
    if (/Potential Match/.test(message)) summaryCount++;
  });
  t.mock.method(whapiClient, "sendBannerImage", async () => {
    bannerCount++;
  });

  await requestPhotosForMatch(REQUESTER_PHONE, listing, 1);
  await handleIncomingSellerPhoto(SELLER_PHONE, "https://cdn.example/img1.jpg");
  await handleIncomingSellerPhoto(SELLER_PHONE, "https://cdn.example/img2.jpg");
  await handleIncomingSellerPhoto(SELLER_PHONE, "https://cdn.example/img3.jpg");

  assert.equal(bannerCount, 3, "every photo must be forwarded");
  assert.equal(summaryCount, 1, "the match summary must only be resent once per request");

  const record = await getPhotoRequestRecord(listing.source, listing.type, listing.id);
  assert.equal(record?.photos.length, 3);
});

test("an image from a phone with no open photo request is not handled here, and falls through", async () => {
  const handled = await handleIncomingSellerPhoto("10000000000", "https://cdn.example/unrelated.jpg");
  assert.equal(handled, false);
});
