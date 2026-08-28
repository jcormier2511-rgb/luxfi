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

test("mapToInventoryListings captures the listing's own frontImage as its primary photo", () => {
  const withPhoto = sale({
    listings: [{ ...sale().listings[0], frontImage: "https://watchfacts.com/media/sale-1.jpg" }],
  });
  const [listing] = mapToInventoryListings(withPhoto, "FS");
  assert.equal(listing.imageUrl, "https://watchfacts.com/media/sale-1.jpg");
});

test("mapToInventoryListings leaves imageUrl undefined rather than null/empty when no frontImage exists", () => {
  const [listing] = mapToInventoryListings(sale(), "FS"); // default fixture's frontImage is null
  assert.equal(listing.imageUrl, undefined);
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

test("required regression: a single-listing sale's own title price is trusted over a structured sale.price that disagrees with it", () => {
  // Exact reported live bug: sale.price = 2 while the listing's own title clearly states
  // "105.000 USD" — the structured field was garbage, the title was correct.
  const [listing] = mapToInventoryListings(
    sale({
      price: 2,
      title: "Patek 5712G FullSet 2024 105.000 USD (Ref. 5712G)",
      listings: [
        {
          id: "sale-1",
          brand: "Patek Philippe",
          model: null,
          reference: "5712G",
          normalizedReference: null,
          title: "Patek 5712G FullSet 2024 105.000 USD (Ref. 5712G)",
          condition: "New",
          frontImage: null,
          box: "Yes",
          papers: "Yes",
          dialColor: null,
        },
      ],
    }),
    "FS"
  );
  assert.equal(listing.price, "105000", "the title's own unambiguous price must win over a disagreeing structured field");
});

function saleWithListingTitle(title: string, overrides: Partial<RawFlashSale> = {}): RawFlashSale {
  const base = sale(overrides);
  return { ...base, title, listings: base.listings.map((l) => ({ ...l, title })) };
}

test("mapToInventoryListings still uses the structured sale.price when the title has no price of its own to check against", () => {
  const [listing] = mapToInventoryListings(saleWithListingTitle("Rolex Daytona 116500LN, box and papers", { price: 28500 }), "FS");
  assert.equal(listing.price, "28500");
});

test("mapToInventoryListings falls back to the title's own price when the structured field is 0/missing", () => {
  const [listing] = mapToInventoryListings(saleWithListingTitle("Rolex Daytona 116500LN asking $28,500", { price: 0 }), "FS");
  assert.equal(listing.price, "28500");
});

test("a bundle sub-listing's own title price is still never trusted — sale.price there is the whole lot's total, not a per-item signal", () => {
  const bundleSale = sale({
    price: 500000,
    listings: [
      {
        id: "d1",
        brand: "Rolex",
        model: null,
        reference: "116500LN",
        normalizedReference: null,
        title: "Rolex Daytona 116500LN asking $63,000",
        condition: "New",
        frontImage: null,
        box: null,
        papers: null,
        dialColor: null,
      },
      {
        id: "d2",
        brand: "Patek Philippe",
        model: null,
        reference: "5711",
        normalizedReference: null,
        title: "Nautilus 5711",
        condition: "Used",
        frontImage: null,
        box: null,
        papers: null,
        dialColor: null,
      },
    ],
  });
  const listings = mapToInventoryListings(bundleSale, "FS");
  assert.ok(
    listings.every((l) => l.price === "ASK"),
    "a bundle item's price must stay ASK even when its own title happens to name a price"
  );
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

test("required regression: a sub-listing's id is keyed on sale.id + detail.id, not its array position", () => {
  const detailA = { id: "watch-a", brand: "Rolex", model: null, reference: "116500LN", normalizedReference: null, title: "Daytona", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null };
  const detailB = { id: "watch-b", brand: "Patek Philippe", model: null, reference: "5711", normalizedReference: null, title: "Nautilus", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null };

  const originalOrder = mapToInventoryListings(sale({ isBundle: true, listings: [detailA, detailB] }), "FS");
  // Simulates a re-sync where WatchFacts returns the same two watches in a different order
  // (e.g. one was re-saved, or the API just doesn't guarantee stable ordering).
  const reorderedSync = mapToInventoryListings(sale({ isBundle: true, listings: [detailB, detailA] }), "FS");

  const idFor = (listings: typeof originalOrder, ref: string) => listings.find((l) => l.ref === ref)!.id;

  assert.equal(
    idFor(originalOrder, "116500LN"),
    idFor(reorderedSync, "116500LN"),
    "the Daytona's id must stay the same regardless of its position in the array"
  );
  assert.equal(
    idFor(originalOrder, "5711"),
    idFor(reorderedSync, "5711"),
    "the Nautilus's id must stay the same regardless of its position in the array"
  );
  assert.ok(idFor(originalOrder, "116500LN").includes("watch-a"), "id must incorporate the sub-listing's own detail.id");
  assert.ok(idFor(originalOrder, "5711").includes("watch-b"), "id must incorporate the sub-listing's own detail.id");
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

test("required regression: a bundle sub-listing's item/description come from its own detail.title, never the parent sale's bundle-wide title", () => {
  const bundleSale = sale({
    isBundle: true,
    title: "MASSIVE DEALER LOT — everything must go, DM for full list",
    listings: [
      { id: "a", brand: "Rolex", model: null, reference: "116500LN", normalizedReference: null, title: "Rolex Daytona 116500LN white dial", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "b", brand: "Patek Philippe", model: null, reference: "5711", normalizedReference: null, title: "Patek Nautilus 5711 blue dial", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
    ],
  });
  const listings = mapToInventoryListings(bundleSale, "FS");
  assert.ok(
    listings.every((l) => !/MASSIVE DEALER LOT/.test(l.description) && !/MASSIVE DEALER LOT/.test(l.item)),
    "a sub-listing's own description/item must never carry the whole dealer blast text"
  );
  assert.equal(listings[0].item, "Rolex Daytona 116500LN white dial");
  assert.equal(listings[1].description, "Patek Nautilus 5711 blue dial");
});

test("required regression: when a sub-listing has no structured reference field, one is extracted from that sub-listing's own title only", () => {
  const bundleSale = sale({
    isBundle: true,
    listings: [
      // WatchFacts sometimes leaves reference/normalizedReference empty even though the title has it.
      { id: "a", brand: "Rolex", model: null, reference: null, normalizedReference: null, title: "Rolex Daytona 116500LN white dial", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
      { id: "b", brand: "Patek Philippe", model: null, reference: null, normalizedReference: null, title: "Patek Nautilus 5711 blue dial", condition: "Used", frontImage: null, box: null, papers: null, dialColor: null },
    ],
  });
  const listings = mapToInventoryListings(bundleSale, "FS");
  assert.equal(listings[0].ref, "116500LN", "must extract from this sub-listing's own title, not fall back to empty");
  assert.equal(listings[1].ref, "5711", "each sub-listing's reference extraction is independent of its siblings");
});

test("mapToInventoryListings falls back to one empty-detail entry when a sale has no listings array", () => {
  // A title with no extractable reference isolates this test's actual purpose (one placeholder
  // entry, not zero/many) from the separate reference-extraction-from-title behavior, which has
  // its own dedicated tests above.
  const listings = mapToInventoryListings(sale({ listings: [], title: "Assorted watch lot" }), "FS");
  assert.equal(listings.length, 1);
  assert.equal(listings[0].ref, "");
  assert.equal(listings[0].id, "sale-1");
});
