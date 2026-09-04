import type { Dealer, Listing } from "@prisma/client";
import type { ReviewProfile } from "../domain/reviewService.js";

function formatPrice(listing: Pick<Listing, "priceMin" | "priceMax" | "currency">): string | null {
  const { priceMin, priceMax, currency } = listing;
  const fmt = (n: number) => `${currency === "USD" ? "$" : currency + " "}${n.toLocaleString("en-US")}`;
  if (priceMin != null && priceMax != null && priceMin !== priceMax) return `${fmt(priceMin)}–${fmt(priceMax)}`;
  if (priceMax != null) return fmt(priceMax);
  if (priceMin != null) return fmt(priceMin);
  return null;
}

function listingDescription(listing: Listing): string {
  const parts = [listing.brand, listing.model, listing.reference].filter(Boolean);
  return parts.length ? parts.join(" ") : "listing";
}

export function formatReviewFragment(dealer: Dealer, avgRating: number | null): string {
  const nameOrHandle = dealer.name ?? "Unverified dealer";
  const tierLabel = dealer.trustTier.charAt(0) + dealer.trustTier.slice(1).toLowerCase();
  const ratingFragment = avgRating != null ? `${avgRating.toFixed(1)}★` : "no ratings yet";
  return `${nameOrHandle} · ${tierLabel} · ${dealer.vouchCount} vouches · ${ratingFragment}`;
}

/**
 * Fi's advisory checks on the counterparty's listing — never a reason to
 * block the match, just something worth the dealer's attention. Silent when
 * a check wasn't run (no photo posted) or came back inconclusive/unknown.
 */
function formatAdvisoryLines(listing: Listing): string[] {
  const lines: string[] = [];

  if (listing.authenticityVerdict === "possible_concern") {
    lines.push(`⚠️ Photo check: ${listing.authenticityNotes ?? "possible authenticity concern — verify in person."}`);
  } else if (listing.authenticityVerdict === "likely_authentic") {
    lines.push("✅ Photo checked — no obvious authenticity red flags.");
  }

  if (listing.priceVerdict === "below_market" || listing.priceVerdict === "above_market") {
    const range = listing.marketPriceMin != null && listing.marketPriceMax != null
      ? ` (typical: $${listing.marketPriceMin.toLocaleString()}-${listing.marketPriceMax.toLocaleString()})`
      : "";
    lines.push(`⚠️ Price check: ${listing.priceVerdict === "below_market" ? "below" : "above"} market${range} — ${listing.priceNotes ?? "verify carefully."}`);
  } else if (listing.priceVerdict === "in_line") {
    lines.push("✅ Price checked — in line with market.");
  }

  return lines;
}

export function formatMatchNotification(params: {
  role: "buyer" | "seller";
  counterpartyListing: Listing;
  counterparty: Dealer;
  counterpartyReview: ReviewProfile;
  creditsCharged: number;
}): string {
  const { role, counterpartyListing, counterparty, counterpartyReview, creditsCharged } = params;
  const price = formatPrice(counterpartyListing);
  const desc = listingDescription(counterpartyListing);
  const reviewLine = formatReviewFragment(counterparty, counterpartyReview.avgRating);
  const roleLine = role === "buyer" ? "Seller" : "Buyer";
  const creditLine = creditsCharged > 0 ? `${creditsCharged} credits charged.` : "First match free — no credits charged.";

  return [
    `Match found — ${desc}${price ? `, ${price}` : ""}${counterpartyListing.condition ? `, ${counterpartyListing.condition}` : ""}.`,
    `${roleLine}: ${reviewLine}.`,
    creditLine,
    ...formatAdvisoryLines(counterpartyListing),
  ].join(" ");
}

export function formatInsufficientCreditsNotice(listing: Listing): string {
  const desc = listingDescription(listing);
  return `Fi found a verified match for your ${desc} listing, but you're out of credits. Top up to unlock it: https://luxfi.ai/signup`;
}

export function formatVouchRequestToTarget(requesterName: string, dealText: string | null): string {
  const dealLine = dealText ? ` for your recent deal (${dealText})` : "";
  return `Hi — ${requesterName} is requesting a vouch${dealLine}. Reply with a rating 1-5 and a short comment (e.g. "5 fast and reliable") to vouch for them.`;
}

export function formatVouchReceivedNotice(reviewerName: string, rating: number | null): string {
  const ratingLine = rating ? `${rating}★` : "a review";
  return `You've received a new vouch from ${reviewerName}: ${ratingLine}.`;
}
