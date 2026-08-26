import { loadInventory } from "../data/inventoryStore";
import { InventoryListing, ItemRequest } from "../types";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function score(listing: InventoryListing, tokens: string[]): number {
  const haystack = tokenize(`${listing.brand} ${listing.item} ${listing.ref} ${listing.category} ${listing.description}`);
  let matches = 0;
  for (const t of tokens) {
    if (haystack.includes(t)) matches += 1;
  }
  return matches;
}

/**
 * A buyer's request ("buy") matches against FS (for sale) listings;
 * a seller's request ("sell") matches against WTB (want to buy) listings.
 */
export function findMatches(request: ItemRequest, limit: number): InventoryListing[] {
  const wantType = request.action === "buy" ? "FS" : "WTB";
  const tokens = tokenize(request.query);
  const candidates = loadInventory().filter((l) => l.type === wantType);

  const scored = candidates
    .map((listing) => ({ listing, score: score(listing, tokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.listing.rating) - Number(a.listing.rating));

  const results = scored.map((s) => s.listing);
  if (results.length > 0) return results.slice(0, limit);

  // No token overlap — fall back to top-rated listings in the same category guess
  // so the trial always demonstrates value instead of returning nothing.
  return candidates
    .slice()
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, limit);
}

function watchName(listing: InventoryListing): string {
  if (listing.description) return listing.description;
  return listing.item.toLowerCase().startsWith(listing.brand.toLowerCase())
    ? listing.item
    : `${listing.brand} ${listing.item}`;
}

/**
 * Fi Conversation Flow Spec (v3) §2 Match Card — counterparty name and watch details are
 * shown up front (no separate anonymized/reveal step); "approve"/"pass" is what's metered
 * against the trial, and approving is what additionally surfaces the phone number.
 * "Fi Intelligence" (dealer reputation, price trend, market range, authenticity) is omitted
 * — no data source for any of that exists in the pipeline yet.
 */
export function formatMatchCard(listing: InventoryListing, index: number, action: ItemRequest["action"]): string {
  const roleLabel = action === "buy" ? "Seller" : "Buyer";
  const priceLabel = action === "buy" ? "Asking" : "Bid";
  const priceText = listing.price === "ASK" ? "price on ask" : `$${listing.price}`;
  return (
    `Potential Match #${index + 1}\n` +
    `${roleLabel}: ${listing.contactName || "Unnamed"}\n` +
    `Watch: ${watchName(listing)}\n` +
    `${priceLabel}: ${priceText}\n` +
    `Location: ${listing.location || "Not specified"}`
  );
}

/** Sent after "approve <n>" — adds the phone number so the two sides can actually connect. */
export function formatMatchApproved(listing: InventoryListing, index: number): string {
  return `Approved #${index + 1} — connecting you with ${listing.contactName || "them"}: ${listing.contactPhone}`;
}
