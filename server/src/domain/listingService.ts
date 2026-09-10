import type { Listing } from "@prisma/client";
import { prisma } from "../db.js";
import type { ExtractedListing } from "../llm/listingExtractor.js";

export async function createListing(
  parsed: ExtractedListing,
  context: { dealerId: string; groupId: string; rawText: string; imageUrl: string | null },
): Promise<Listing> {
  return prisma.listing.create({
    data: {
      type: parsed.type,
      category: parsed.category,
      brand: parsed.brand,
      reference: parsed.reference,
      model: parsed.model,
      condition: parsed.condition,
      priceMin: parsed.priceMin,
      priceMax: parsed.priceMax,
      currency: parsed.currency,
      location: parsed.location,
      rawText: context.rawText,
      imageUrl: context.imageUrl,
      dealerId: context.dealerId,
      groupId: context.groupId,
    },
  });
}
