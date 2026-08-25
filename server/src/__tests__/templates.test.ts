import { describe, expect, it } from "vitest";
import type { Dealer, Listing } from "@prisma/client";
import { formatMatchNotification } from "../messaging/templates.js";
import type { ReviewProfile } from "../domain/reviewService.js";

function listing(overrides: Partial<Listing>): Listing {
  return {
    id: "listing-1",
    type: "FS",
    status: "OPEN",
    category: "watch",
    brand: "Rolex",
    reference: "116500LN",
    model: "Daytona",
    condition: null,
    priceMin: 18500,
    priceMax: 18500,
    currency: "USD",
    location: null,
    notes: null,
    rawText: "FS Rolex Daytona 116500LN $18,500",
    imageUrl: null,
    authenticityVerdict: null,
    authenticityNotes: null,
    priceVerdict: null,
    priceNotes: null,
    marketPriceMin: null,
    marketPriceMax: null,
    dealerId: "dealer-1",
    groupId: "group-1",
    createdAt: new Date(),
    ...overrides,
  };
}

function dealer(overrides: Partial<Dealer> = {}): Dealer {
  return {
    id: "dealer-1",
    whatsappId: "155500000@c.us",
    name: "Marco D.",
    trustTier: "UNVERIFIED",
    vouchCount: 0,
    ratingSum: 0,
    ratingCount: 0,
    credits: 0,
    freeMatchesUsed: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

const noReviews: ReviewProfile = { dealer: dealer(), avgRating: null, recentReviews: [] };

describe("formatMatchNotification advisory lines", () => {
  it("includes a warning line for a possible authenticity concern", () => {
    const msg = formatMatchNotification({
      role: "buyer",
      counterpartyListing: listing({ authenticityVerdict: "possible_concern", authenticityNotes: "engraving font looks off" }),
      counterparty: dealer(),
      counterpartyReview: noReviews,
      creditsCharged: 15,
    });
    expect(msg).toContain("⚠️ Photo check: engraving font looks off");
  });

  it("includes a reassuring line when authenticity looks fine", () => {
    const msg = formatMatchNotification({
      role: "buyer",
      counterpartyListing: listing({ authenticityVerdict: "likely_authentic" }),
      counterparty: dealer(),
      counterpartyReview: noReviews,
      creditsCharged: 15,
    });
    expect(msg).toContain("✅ Photo checked — no obvious authenticity red flags.");
  });

  it("omits a photo check line when inconclusive or not run", () => {
    const msg = formatMatchNotification({
      role: "buyer",
      counterpartyListing: listing({ authenticityVerdict: "inconclusive" }),
      counterparty: dealer(),
      counterpartyReview: noReviews,
      creditsCharged: 15,
    });
    expect(msg).not.toContain("Photo check");
    expect(msg).not.toContain("Photo checked");
  });

  it("includes market range in a below-market warning", () => {
    const msg = formatMatchNotification({
      role: "buyer",
      counterpartyListing: listing({ priceVerdict: "below_market", marketPriceMin: 17000, marketPriceMax: 19000, priceNotes: "unusually cheap" }),
      counterparty: dealer(),
      counterpartyReview: noReviews,
      creditsCharged: 15,
    });
    expect(msg).toContain("⚠️ Price check: below market (typical: $17,000-19,000) — unusually cheap");
  });

  it("omits a price line when the verdict is unknown", () => {
    const msg = formatMatchNotification({
      role: "buyer",
      counterpartyListing: listing({ priceVerdict: "unknown" }),
      counterparty: dealer(),
      counterpartyReview: noReviews,
      creditsCharged: 15,
    });
    expect(msg).not.toContain("Price check");
    expect(msg).not.toContain("Price checked");
  });
});
