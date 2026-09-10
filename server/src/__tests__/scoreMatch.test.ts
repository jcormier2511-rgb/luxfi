import { describe, expect, it } from "vitest";
import { bestMatch, scoreMatch, type ListingLike } from "../matching/scoreMatch.js";

function listing(overrides: Partial<ListingLike>): ListingLike {
  return {
    dealerId: "dealer-a",
    category: "watch",
    brand: null,
    reference: null,
    priceMin: null,
    priceMax: null,
    location: null,
    ...overrides,
  };
}

describe("scoreMatch", () => {
  it("matches on identical brand + reference regardless of formatting", () => {
    const wtb = listing({ dealerId: "buyer", brand: "Rolex", reference: "116500LN", priceMax: 20000 });
    const fs = listing({ dealerId: "seller", brand: "rolex", reference: "116500-ln", priceMin: 18500 });
    expect(scoreMatch(wtb, fs)).not.toBeNull();
  });

  it("rejects a different brand", () => {
    const wtb = listing({ dealerId: "buyer", brand: "Rolex" });
    const fs = listing({ dealerId: "seller", brand: "Omega" });
    expect(scoreMatch(wtb, fs)).toBeNull();
  });

  it("rejects mismatched references even with matching brand", () => {
    const wtb = listing({ dealerId: "buyer", brand: "Rolex", reference: "116500LN" });
    const fs = listing({ dealerId: "seller", brand: "Rolex", reference: "126610LN" });
    expect(scoreMatch(wtb, fs)).toBeNull();
  });

  it("rejects when the seller's ask is well above the buyer's max", () => {
    const wtb = listing({ dealerId: "buyer", brand: "Rolex", priceMax: 15000 });
    const fs = listing({ dealerId: "seller", brand: "Rolex", priceMin: 25000 });
    expect(scoreMatch(wtb, fs)).toBeNull();
  });

  it("requires a brand on both sides", () => {
    const wtb = listing({ dealerId: "buyer", priceMax: 15000 });
    const fs = listing({ dealerId: "seller", brand: "Rolex", priceMin: 14000 });
    expect(scoreMatch(wtb, fs)).toBeNull();
  });

  it("rejects a listing matching itself (same dealer)", () => {
    const wtb = listing({ dealerId: "same", brand: "Rolex" });
    const fs = listing({ dealerId: "same", brand: "Rolex" });
    expect(scoreMatch(wtb, fs)).toBeNull();
  });

  it("bestMatch prefers a reference match over a brand-only match", () => {
    const wtb = listing({ dealerId: "buyer", brand: "Rolex", reference: "116500LN", priceMax: 20000 });
    const brandOnly = listing({ dealerId: "seller-a", brand: "Rolex", priceMin: 19000 });
    const refMatch = listing({ dealerId: "seller-b", brand: "Rolex", reference: "116500LN", priceMin: 19000 });
    expect(bestMatch(wtb, [brandOnly, refMatch])).toBe(refMatch);
  });
});
