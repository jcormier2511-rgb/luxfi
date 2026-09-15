import type { Listing } from "@prisma/client";
import { prisma } from "../db.js";
import { checkAuthenticity } from "../llm/authenticityChecker.js";
import { checkPrice } from "../llm/priceChecker.js";

/**
 * Runs Fi's authenticity (if a photo was posted) and price checks for a
 * freshly created listing, in parallel, and persists whatever came back.
 * Both are best-effort — a failed check just leaves its fields null rather
 * than blocking listing intake or matching.
 */
export async function runListingChecks(listing: Listing): Promise<Listing> {
  const [authenticity, price] = await Promise.all([
    listing.imageUrl
      ? checkAuthenticity({
          imageUrl: listing.imageUrl,
          brand: listing.brand,
          model: listing.model,
          reference: listing.reference,
          category: listing.category,
        })
      : null,
    checkPrice({
      brand: listing.brand,
      model: listing.model,
      reference: listing.reference,
      category: listing.category,
      condition: listing.condition,
      priceMin: listing.priceMin,
      priceMax: listing.priceMax,
      currency: listing.currency,
    }),
  ]);

  if (!authenticity && !price) return listing;

  return prisma.listing.update({
    where: { id: listing.id },
    data: {
      authenticityVerdict: authenticity?.verdict,
      authenticityNotes: authenticity?.notes,
      priceVerdict: price?.verdict,
      priceNotes: price?.notes,
      marketPriceMin: price?.marketMin,
      marketPriceMax: price?.marketMax,
    },
  });
}
