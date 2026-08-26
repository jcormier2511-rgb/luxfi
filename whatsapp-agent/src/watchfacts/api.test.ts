import { test } from "node:test";
import assert from "node:assert/strict";
import { isActive, mapToInventoryListing, RawFlashSale } from "./api";

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

test("mapToInventoryListing maps structured API fields, never CTA/button text", () => {
  const listing = mapToInventoryListing(sale(), "FS");
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

test("mapToInventoryListing falls back to fromName/companyWhatsapp when company fields are blank", () => {
  const listing = mapToInventoryListing(sale({ companyName: null, whatsappNumber: null, fromName: "Sean Ash" }), "FS");
  assert.equal(listing.contactName, "Sean Ash");
  assert.equal(listing.contactPhone, "15551234567"); // falls back to companyWhatsapp
});

test("mapToInventoryListing treats a 0 top-level price as ASK", () => {
  const listing = mapToInventoryListing(sale({ price: 0 }), "FS");
  assert.equal(listing.price, "ASK");
});

test("mapToInventoryListing tags WTB the same way as FS, just with a different type", () => {
  const listing = mapToInventoryListing(sale(), "WTB");
  assert.equal(listing.type, "WTB");
  assert.equal(listing.id, "sale-1");
});
