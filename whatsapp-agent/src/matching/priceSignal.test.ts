import { test } from "node:test";
import assert from "node:assert/strict";
import { computePriceSignal } from "./priceSignal";
import { InventoryListing } from "../types";

function listing(id: string, overrides: Partial<InventoryListing> = {}): InventoryListing {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "28000",
    location: "",
    contactName: "",
    contactPhone: "",
    source: "WF",
    rating: "",
    description: "",
    ...overrides,
  };
}

test("required regression: a bezel/part price mistakenly stored as the listing price surfaces as Attractive against real comps", () => {
  // The live bug this was built for: a Daytona 116500LN listing whose price field ended up
  // as $2,500 (the ceramic bezel's price from the description, not the watch's), sitting
  // among other real 116500LN listings priced in the $26k-$30k range.
  const bezelPricedListing = listing("bezel-bug", { price: "2500" });
  const comps = [listing("comp-1", { id: "comp-1", price: "28000" }), listing("comp-2", { id: "comp-2", price: "29500" })];
  assert.equal(computePriceSignal(bezelPricedListing, comps), "Attractive");
});

test("a price within the normal range of its comps is Fair", () => {
  const target = listing("target", { price: "28000" });
  const comps = [listing("comp-1", { id: "comp-1", price: "27000" }), listing("comp-2", { id: "comp-2", price: "29000" })];
  assert.equal(computePriceSignal(target, comps), "Fair");
});

test("a price well above its comps is High", () => {
  const target = listing("target", { price: "45000" });
  const comps = [listing("comp-1", { id: "comp-1", price: "28000" }), listing("comp-2", { id: "comp-2", price: "29000" })];
  assert.equal(computePriceSignal(target, comps), "High");
});

test("fewer than 2 comparable listings returns null rather than guessing off too little data", () => {
  const target = listing("target", { price: "2500" });
  const oneComp = [listing("comp-1", { id: "comp-1", price: "28000" })];
  assert.equal(computePriceSignal(target, oneComp), null);
  assert.equal(computePriceSignal(target, []), null);
});

test("comps only count listings for the same reference, not just any active FS listing", () => {
  const target = listing("target", { ref: "116500LN", price: "2500" });
  const unrelatedComps = [
    listing("other-1", { id: "other-1", ref: "5711", price: "60000" }),
    listing("other-2", { id: "other-2", ref: "126710BLRO", price: "40000" }),
  ];
  assert.equal(computePriceSignal(target, unrelatedComps), null, "no comps for this reference -- must not compare against unrelated watches");
});

test("the listing itself is never counted as its own comp", () => {
  const target = listing("target", { price: "28000" });
  // Only one *other* comp besides itself -- below the MIN_COMPARABLE_LISTINGS threshold.
  const comps = [target, listing("comp-1", { id: "comp-1", price: "29000" })];
  assert.equal(computePriceSignal(target, comps), null);
});

test("a WTB comp is never counted -- comps are asking prices, not buyer offers", () => {
  const target = listing("target", { price: "2500" });
  const comps = [
    listing("wtb-1", { id: "wtb-1", type: "WTB", price: "28000" }),
    listing("wtb-2", { id: "wtb-2", type: "WTB", price: "29000" }),
  ];
  assert.equal(computePriceSignal(target, comps), null, "WTB listings must not count toward the FS comp pool");
});

test("returns null for an ASK-priced or reference-less listing -- nothing to compare", () => {
  const comps = [listing("comp-1", { id: "comp-1", price: "28000" }), listing("comp-2", { id: "comp-2", price: "29000" })];
  assert.equal(computePriceSignal(listing("ask", { price: "ASK" }), comps), null);
  assert.equal(computePriceSignal(listing("no-ref", { ref: "" }), comps), null);
});

test("reference matching allows a bare base reference to compare against a dial-suffixed comp, same rule as findMatches", () => {
  const target = listing("target", { ref: "116500", price: "2500" });
  const comps = [
    listing("comp-1", { id: "comp-1", ref: "116500LN", price: "28000" }),
    listing("comp-2", { id: "comp-2", ref: "116500LN", price: "29500" }),
  ];
  assert.equal(computePriceSignal(target, comps), "Attractive");
});

test("foreign-currency listings are compared using converted USD amounts", () => {
  const target = listing("target", { price: "HKD 200000", priceUsd: 25600 });
  const comps = [
    listing("comp-1", { id: "comp-1", price: "25000", priceUsd: 25000 }),
    listing("comp-2", { id: "comp-2", price: "26000", priceUsd: 26000 }),
  ];
  assert.equal(computePriceSignal(target, comps), "Fair");
});

test("a foreign-currency listing without a conversion gets no price signal", () => {
  const target = listing("target", { price: "HKD 200000" });
  const comps = [
    listing("comp-1", { id: "comp-1", price: "25000" }),
    listing("comp-2", { id: "comp-2", price: "26000" }),
  ];
  assert.equal(computePriceSignal(target, comps), null);
});
