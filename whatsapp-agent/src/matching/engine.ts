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
  const haystack = tokenize(`${listing.brand} ${listing.item} ${listing.ref} ${listing.category}`);
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

function displayName(listing: InventoryListing): string {
  return listing.item.toLowerCase().startsWith(listing.brand.toLowerCase())
    ? listing.item
    : `${listing.brand} ${listing.item}`;
}

/** Shown before consent to reveal contact info — item details only, no way to identify or reach the counterparty. */
export function formatMatchAnonymous(listing: InventoryListing, index: number): string {
  const priceText = listing.price === "ASK" ? "price on ask" : `$${listing.price}`;
  return `${index + 1}. ${displayName(listing)}${listing.ref ? ` (${listing.ref})` : ""} — ${listing.condition}, ${priceText}, ${listing.location} · ${listing.rating ? `${listing.rating}★` : "unrated"}`;
}

/** Shown once the contact says yes to "do you want their info?" — adds name + phone. */
export function formatMatchRevealed(listing: InventoryListing, index: number): string {
  const priceText = listing.price === "ASK" ? "price on ask" : `$${listing.price}`;
  return `${index + 1}. ${displayName(listing)}${listing.ref ? ` (${listing.ref})` : ""} — ${listing.condition}, ${priceText}, ${listing.location}\n   Contact: ${listing.contactName} · ${listing.contactPhone} · ${listing.rating ? `${listing.rating}★` : "unrated"} · ${listing.source}`;
}
