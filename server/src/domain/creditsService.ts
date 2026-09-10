import type { Dealer } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";

export interface ChargeResult {
  ok: boolean;
  creditsCharged: number;
  usedFreeMatch: boolean;
  balanceAfter: number;
}

/** Credits a dealer would owe for their next match, before free matches. */
export function creditsDueForNextMatch(dealer: Pick<Dealer, "freeMatchesUsed">): number {
  const hasFreeMatchLeft = dealer.freeMatchesUsed < config.matching.freeMatchesPerDealer;
  return hasFreeMatchLeft ? 0 : config.matching.creditsPerMatch;
}

export function canAffordNextMatch(dealer: Pick<Dealer, "freeMatchesUsed" | "credits">): boolean {
  return dealer.credits >= creditsDueForNextMatch(dealer);
}

/**
 * Charges a dealer for a verified match: consumes a free match if available,
 * otherwise deducts `creditsPerMatch`. Fails closed (no charge, ok:false) if
 * the dealer can't afford it — callers must not deliver the match in that case.
 */
export async function chargeForMatch(dealerId: string, reason: string): Promise<ChargeResult> {
  return prisma.$transaction(async (tx) => {
    const dealer = await tx.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    const due = creditsDueForNextMatch(dealer);
    const usedFreeMatch = due === 0;

    if (dealer.credits < due) {
      return { ok: false, creditsCharged: 0, usedFreeMatch: false, balanceAfter: dealer.credits };
    }

    const updated = await tx.dealer.update({
      where: { id: dealerId },
      data: {
        credits: { decrement: due },
        freeMatchesUsed: usedFreeMatch ? { increment: 1 } : undefined,
      },
    });

    await tx.creditTransaction.create({
      data: {
        dealerId,
        amount: -due,
        reason: usedFreeMatch ? `${reason} (free match)` : reason,
        balanceAfter: updated.credits,
      },
    });

    return { ok: true, creditsCharged: due, usedFreeMatch, balanceAfter: updated.credits };
  });
}

export async function grantCredits(dealerId: string, amount: number, reason: string): Promise<Dealer> {
  const updated = await prisma.dealer.update({
    where: { id: dealerId },
    data: { credits: { increment: amount } },
  });
  await prisma.creditTransaction.create({
    data: { dealerId, amount, reason, balanceAfter: updated.credits },
  });
  return updated;
}
