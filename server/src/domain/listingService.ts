import type { Listing } from "@prisma/client";
import { prisma } from "../db.js";
import type { ParsedListing } from "../parsing/listingParser.js";

export async function createListing(
  parsed: ParsedListing,
  context: { dealerId: string; groupId: string; rawText: string },
): Promise<Listing> {
  return prisma.listing.create({
    data: {
      type: parsed.type,
      brand: parsed.brand,
      reference: parsed.reference,
      model: parsed.model,
      condition: parsed.condition,
      priceMin: parsed.priceMin,
      priceMax: parsed.priceMax,
      currency: parsed.currency,
      location: parsed.location,
      notes: parsed.notes,
      rawText: context.rawText,
      dealerId: context.dealerId,
      groupId: context.groupId,
    },
  });
}
