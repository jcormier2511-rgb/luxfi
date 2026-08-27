import { test } from "node:test";
import assert from "node:assert/strict";
import { isActive, mapToInventoryListings, RawFlashSale } from "./api";

function sale(overrides: Partial<RawFlashSale> = {}): RawFlashSale {
  return {
    id: "sale-1",
    isBundle: false,
    title: "Rolex Daytona 116500LN",
    status: "open",
    price: 18500,
    deadline: "2999-01-01 00:00:00",
    listings: [
      {
        id: "sale-1",
        brand: "Rolex",
        model: null,
        reference: "116500LN",
        normalizedReference: null,
        title: "Rolex Daytona 116500LN",
        condition: "Used",
        frontImage: null,
        box: "Yes",
        papers: "No",
        dialColor: "White",
      },
    ],
    companyName: "Marco D.",
    fromName: null,
    companyStars: 4,
    whatsappNumber: "15551234567",
    companyWhatsapp: "15551234567",
    region: "North America",
    ...overrides,
  };
}

test("isActive rejects closed listings", () => {
  assert.equal(isActive(sale({ status: "closed" })), false);
});

test("isActive rejects listings past their deadline", () => {
  assert.equal(isActive(sale({ deadline: "2000-01-01 00:00:00" })), false);
});

test("isActive accepts open, not-yet-expired listings", () => {
  assert.equal(isActive(sale()), true);
});

test("isActive doesn't reject on an unparseable deadline (own-bug safety, not a data-quality filter)", () => {
  assert.equal(isActive(sale({ deadline: "not-a-date" })), true);
});

test("mapToInventoryListings maps structured API fields, never CTA/button text", () => {
  const [listing] = mapToInventoryListings(sale(), "FS");
  assert.equal(listing.id, "sale-1");
  assert.equal(listing.type, "FS");
  assert.equal(listing.contactName, "Marco D.");
  assert.equal(listing.contactPhone, "15551234567");
  assert.equal(listing.brand, "Rolex");
  assert.equal(listing.ref, "116500LN");
  assert.equal(listing.condition, "Used");
  assert.equal(listing.price, "18500");
  assert.doesNotMatch(listing.contactName, /view details|check availability/i);
  assert.doesNotMatch(listing.item, /view details|check availability/i);
});

test("mapToInventoryListings falls back to fromName/companyWhatsapp when company fields are blank", () => {
  const [listing] = mapToInventoryListings(sale({ companyName: null, whatsappNumber: null, fromName: "Sean Ash" }), "FS");
  assert.equal(listing.contactName, "Sean Ash");
  assert.equal(listing.contactPhone, "15551234567"); // falls back to companyWhatsapp
});

test("mapToInventoryListings treats a 0 top-level price as ASK for a single-listing sale", () => {
  const [listing] = mapToInventoryListings(sale({ price: 0 }), "FS");
  assert.equal(listing.price, "ASK");
});

test("mapToInventoryListings tags WTB the same way as FS, just with a different type", () => {
  const [listing] = mapToInventoryListings(sale(), "WTB");
  assert.equal(listing.type, "WTB");
  assert.equal(listing.id, "sale-1");
});

test("mapToInventoryListings maps every sub-listing in a bundle individually, not just the first", () => {
  const bundleSale = sale({
    isBundle: true,
    listings: [
      { id: "a", brand: "Rolex", model: null, reference: "116500LN", normalizedReference: null, title: "Daytona", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "b", brand: "Rolex", model: null, reference: "126710BLRO", normalizedReference: null, title: "GMT-Master II", condition: "New", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "c", brand: "Patek Philippe", model: null, reference: "5711", normalizedReference: null, title: "Nautilus", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
    ],
  });
  const listings = mapToInventoryListings(bundleSale, "FS");
  assert.equal(listings.length, 3, "every sub-listing must produce its own entry, not just the bundle's first watch");
  assert.deepEqual(
    listings.map((l) => l.ref),
    ["116500LN", "126710BLRO", "5711"]
  );
  assert.deepEqual(new Set(listings.map((l) => l.id)).size, 3, "each sub-listing must get its own unique id");
});

test("mapToInventoryListings uses ASK for every sub-listing in a bundle, never the shared lot total", () => {
  const bundleSale = sale({
    price: 500000, // the whole lot's price — ambiguous per individual watch
    listings: [
      { id: "a", brand: "Rolex", model: null, reference: "116500LN", normalizedReference: null, title: "Daytona", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "b", brand: "Rolex", model: null, reference: "126710BLRO", normalizedReference: null, title: "GMT-Master II", condition: "New", frontImage: null, box: null, papers: null, dialColor: null },
    ],
  });
  const listings = mapToInventoryListings(bundleSale, "FS");
  assert.ok(
    listings.every((l) => l.price === "ASK"),
    "a bundle's shared total price must never be attributed to each individual sub-listing"
  );
});

test("mapToInventoryListings falls back to one empty-detail entry when a sale has no listings array", () => {
  const listings = mapToInventoryListings(sale({ listings: [] }), "FS");
  assert.equal(listings.length, 1);
  assert.equal(listings[0].ref, "");
  assert.equal(listings[0].id, "sale-1");
});
