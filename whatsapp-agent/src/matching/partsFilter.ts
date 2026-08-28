import { extractReference } from "../postings/normalize";

/**
 * Excludes a standalone watch part/accessory listing (a bezel, bracelet, dial, crystal, etc.)
 * from matching against a complete-watch request. Live bug this covers: a WatchFacts listing
 * titled "Ceramic Bezel $2500+. Shipped" carried a real reference number (mentioned in its own
 * text) and so matched a buyer's Daytona 116500LN search — the $2,500 price was correctly
 * extracted (it really is what the bezel costs), but the listing itself was never the watch the
 * buyer was searching for.
 *
 * Deliberately narrow, to avoid excluding a real watch listing that merely mentions a part in
 * passing ("full set, extra bracelet link included") or leads with a dial color ("White Dial
 * Daytona 116500LN"): only excludes when a part name leads the title AND no reference number is
 * named that early — a reference named up front means the title is clearly about one specific
 * watch, not a standalone spare part.
 */
const PART_KEYWORDS = /\b(bezel|bracelet|dial|crystal|crown|clasp|buckle|insert|movement|caseback|case back|spring bar)\b/i;
const LEAD_WORD_COUNT = 4;

export function isPartsOrAccessoryListing(listing: { item: string }): boolean {
  const title = listing.item.trim();
  if (!title) return false;
  const lead = title.split(/\s+/).slice(0, LEAD_WORD_COUNT).join(" ");
  if (!PART_KEYWORDS.test(lead)) return false;
  if (extractReference(lead)) return false;
  return true;
}
