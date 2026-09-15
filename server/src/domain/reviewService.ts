import type { Dealer, Review } from "@prisma/client";
import { prisma } from "../db.js";

export interface ReviewProfile {
  dealer: Dealer;
  avgRating: number | null;
  recentReviews: Review[];
}

const VOUCH_KEYWORDS =
  /\b(vouch|reliable|recommend|trustworthy|smooth deal|as described|fast (?:and|&) reliable|scammer|avoid|do not deal|great (?:seller|buyer))\b/i;
const RATING_PATTERN = /\b([1-5])\s*(?:\/\s*5|stars?|⭐)\b/i;

/**
 * Fi's "pull a dealer's review profile from chat history" capability.
 * Heuristically scans messages the network has already observed for
 * mentions of this dealer's name alongside vouch-like language, and
 * records anything found as a Review. Only runs when we don't already
 * have reviews on file, so it doesn't re-scan on every lookup.
 */
export async function scanChatHistoryForVouches(dealer: Dealer): Promise<void> {
  if (!dealer.name) return;

  const existingCount = await prisma.review.count({ where: { subjectDealerId: dealer.id } });
  if (existingCount > 0) return;

  const candidates = await prisma.rawMessage.findMany({
    where: {
      isGroup: true,
      senderId: { not: dealer.whatsappId },
      text: { contains: dealer.name, mode: "insensitive" },
    },
    orderBy: { timestamp: "desc" },
    take: 25,
  });

  const vouchMessages = candidates.filter((m) => VOUCH_KEYWORDS.test(m.text));
  if (vouchMessages.length === 0) return;

  for (const msg of vouchMessages) {
    const ratingMatch = msg.text.match(RATING_PATTERN);
    const rating = ratingMatch?.[1] ? Number.parseInt(ratingMatch[1], 10) : null;
    const reviewer = await prisma.dealer.findUnique({ where: { whatsappId: msg.senderId } });

    await prisma.review.create({
      data: {
        subjectDealerId: dealer.id,
        reviewerDealerId: reviewer?.id ?? null,
        rating,
        text: msg.text.slice(0, 280),
        source: "chat_history",
      },
    });

    await prisma.dealer.update({
      where: { id: dealer.id },
      data: {
        vouchCount: { increment: 1 },
        ratingSum: rating ? { increment: rating } : undefined,
        ratingCount: rating ? { increment: 1 } : undefined,
      },
    });
  }
}

export async function getReviewProfile(dealerId: string): Promise<ReviewProfile> {
  let dealer = await prisma.dealer.findUniqueOrThrow({ where: { id: dealerId } });

  await scanChatHistoryForVouches(dealer);
  dealer = await prisma.dealer.findUniqueOrThrow({ where: { id: dealerId } });

  const recentReviews = await prisma.review.findMany({
    where: { subjectDealerId: dealerId },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  const avgRating = dealer.ratingCount > 0 ? dealer.ratingSum / dealer.ratingCount : null;

  return { dealer, avgRating, recentReviews };
}

export async function requestVouch(
  requester: Dealer,
  target: Dealer,
  dealText: string | null,
): Promise<{ id: string }> {
  const vouchRequest = await prisma.vouchRequest.create({
    data: {
      requesterDealerId: requester.id,
      targetDealerId: target.id,
      dealText,
      status: "PENDING",
    },
  });
  return vouchRequest;
}

/**
 * The oldest pending vouch request awaiting this dealer's reply, if any.
 * Fi's DM agent uses this both to decide whether a "record_vouch" tool call
 * is contextually valid and to compose the request details into its prompt.
 */
export async function getPendingVouchRequest(
  targetDealerId: string,
): Promise<{ id: string; requesterDealerId: string; dealText: string | null } | null> {
  return prisma.vouchRequest.findFirst({
    where: { targetDealerId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
}

/** Records a Review for the original requester and marks the request fulfilled. */
export async function fulfillVouchRequest(
  pending: { id: string; requesterDealerId: string },
  reviewerDealerId: string,
  rating: number | null,
  comment: string,
): Promise<void> {
  await prisma.review.create({
    data: {
      subjectDealerId: pending.requesterDealerId,
      reviewerDealerId,
      rating,
      text: comment.slice(0, 280) || "(no comment)",
      source: "vouch_request",
    },
  });

  await prisma.dealer.update({
    where: { id: pending.requesterDealerId },
    data: {
      vouchCount: { increment: 1 },
      ratingSum: rating ? { increment: rating } : undefined,
      ratingCount: rating ? { increment: 1 } : undefined,
    },
  });

  await prisma.vouchRequest.update({ where: { id: pending.id }, data: { status: "FULFILLED" } });
}
