import type { Listing, Match } from "@prisma/client";
import { prisma } from "../db.js";
import { scoreMatch } from "../matching/scoreMatch.js";
import { canAffordNextMatch, chargeForMatch } from "./creditsService.js";
import { getReviewProfile } from "./reviewService.js";
import { sendDirectMessage } from "../green-api/client.js";
import { formatInsufficientCreditsNotice, formatMatchNotification } from "../messaging/templates.js";

/**
 * Looks for an open opposite-type listing that matches `listing`, and — if
 * both dealers can afford it — executes the match: charges credits on both
 * sides, marks both listings MATCHED, and DMs each dealer their
 * counterparty's listing plus a review summary. Fi never posts back into
 * the group; both notifications go out as 1:1 DMs.
 *
 * Returns the created Match, or null if no qualifying match was found or
 * either side couldn't afford it (in which case both listings stay OPEN
 * for a future match).
 */
export async function attemptMatch(listing: Listing): Promise<Match | null> {
  if (listing.status !== "OPEN" || !listing.brand) return null;

  const oppositeType = listing.type === "WTB" ? "FS" : "WTB";
  const candidates = await prisma.listing.findMany({
    where: {
      status: "OPEN",
      type: oppositeType,
      category: listing.category,
      brand: { equals: listing.brand, mode: "insensitive" },
    },
  });
  if (candidates.length === 0) return null;

  const best = pickBestCandidate(listing, candidates);
  if (!best) return null;

  const wtbListing = listing.type === "WTB" ? listing : best;
  const fsListing = listing.type === "FS" ? listing : best;

  return executeMatch(wtbListing, fsListing);
}

/** Scores `listing` against each candidate (regardless of which side is WTB/FS) and returns the best one. */
function pickBestCandidate(listing: Listing, candidates: Listing[]): Listing | null {
  let best: Listing | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const [wtb, fs] = listing.type === "WTB" ? [listing, candidate] : [candidate, listing];
    const score = scoreMatch(wtb, fs);
    if (score !== null && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

async function executeMatch(wtbListing: Listing, fsListing: Listing): Promise<Match | null> {
  const buyerDealer = await prisma.dealer.findUniqueOrThrow({ where: { id: wtbListing.dealerId } });
  const sellerDealer = await prisma.dealer.findUniqueOrThrow({ where: { id: fsListing.dealerId } });

  if (!canAffordNextMatch(buyerDealer)) {
    await sendDirectMessage(buyerDealer.whatsappId, formatInsufficientCreditsNotice(wtbListing));
    return null;
  }
  if (!canAffordNextMatch(sellerDealer)) {
    await sendDirectMessage(sellerDealer.whatsappId, formatInsufficientCreditsNotice(fsListing));
    return null;
  }

  const dealDesc = [fsListing.brand, fsListing.model, fsListing.reference].filter(Boolean).join(" ");

  const buyerCharge = await chargeForMatch(buyerDealer.id, `Match: ${dealDesc}`);
  if (!buyerCharge.ok) return null;

  const sellerCharge = await chargeForMatch(sellerDealer.id, `Match: ${dealDesc}`);
  if (!sellerCharge.ok) {
    // Race condition: seller's credits changed between the pre-check and the
    // charge. Refund the buyer rather than leave a one-sided charge.
    if (buyerCharge.creditsCharged > 0) {
      await prisma.dealer.update({
        where: { id: buyerDealer.id },
        data: { credits: { increment: buyerCharge.creditsCharged } },
      });
    }
    return null;
  }

  await prisma.listing.update({ where: { id: wtbListing.id }, data: { status: "MATCHED" } });
  await prisma.listing.update({ where: { id: fsListing.id }, data: { status: "MATCHED" } });

  const match = await prisma.match.create({
    data: {
      wtbListingId: wtbListing.id,
      fsListingId: fsListing.id,
      buyerDealerId: buyerDealer.id,
      sellerDealerId: sellerDealer.id,
      creditsChargedBuyer: buyerCharge.creditsCharged,
      creditsChargedSeller: sellerCharge.creditsCharged,
    },
  });

  const sellerReviewProfile = await getReviewProfile(sellerDealer.id);
  const buyerReviewProfile = await getReviewProfile(buyerDealer.id);

  await sendDirectMessage(
    buyerDealer.whatsappId,
    formatMatchNotification({
      role: "buyer",
      counterpartyListing: fsListing,
      counterparty: sellerDealer,
      counterpartyReview: sellerReviewProfile,
      creditsCharged: buyerCharge.creditsCharged,
    }),
  );

  await sendDirectMessage(
    sellerDealer.whatsappId,
    formatMatchNotification({
      role: "seller",
      counterpartyListing: wtbListing,
      counterparty: buyerDealer,
      counterpartyReview: buyerReviewProfile,
      creditsCharged: sellerCharge.creditsCharged,
    }),
  );

  return match;
}
