import { sendText, sendBannerImage } from "../channels";
import {
  getPhotoRequestRecord,
  markPhotoRequested,
  markPhotoRequestUnavailable,
  appendReceivedPhoto,
  findPendingPhotoRequestByContactPhone,
  getListingByKey,
} from "../watchfacts/inventoryDb";
import { InventoryListing } from "../types";
import { formatMatchCard } from "./engine";
import { getActiveGroupCountForContact } from "../postings/groupActivity";

/**
 * Private "request photos before approval" workflow (Fi v4 matching). A photo request is
 * side traffic on a pending match, never a decision: it never touches approval usage (nothing
 * here is metered against the trial or weekly plan cap), and it never flips a match's pending/
 * approved/passed status — the buyer can still approve or pass at any time, with or without photos.
 * Neither party's phone number is ever sent to the other; only Fi (this service's own WhatsApp
 * number) talks to each side directly.
 */

const DUPLICATE_WINDOW_HOURS = 48;

export type PhotoRequestOutcome = "sent" | "duplicate" | "unavailable";

function withinHours(iso: string | null, hours: number): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < hours * 60 * 60 * 1000;
}

/**
 * "photos <n>" / "photo <n>" / "request photos <n>" against an FS/seller match. `displayIndex`
 * is the 1-based number the buyer actually typed (and the same number the original Match Card
 * showed as "Potential Match #N") — persisted so the eventual resend (see
 * handleIncomingSellerPhoto below) can reconstruct the same card the buyer already saw.
 */
export async function requestPhotosForMatch(
  requesterPhone: string,
  listing: InventoryListing,
  displayIndex: number
): Promise<PhotoRequestOutcome> {
  if (!listing.contactPhone) {
    await markPhotoRequestUnavailable(listing.source, listing.type, listing.id);
    return "unavailable";
  }

  const existing = await getPhotoRequestRecord(listing.source, listing.type, listing.id);
  if (existing?.status === "requested" && withinHours(existing.requestedAt, DUPLICATE_WINDOW_HOURS)) {
    return "duplicate";
  }

  const watchName = listing.item || `${listing.brand} ${listing.ref}`.trim();
  await sendText(
    listing.contactPhone,
    `Hi ${listing.contactName || "there"}, a potential counterparty has requested photos of your ${watchName}. ` +
      `Please reply with 3–6 clear photos. Your contact information will remain private until both parties approve.`
  );
  await markPhotoRequested(listing.source, listing.type, listing.id, requesterPhone, String(displayIndex));
  return "sent";
}

/**
 * Routes one incoming (non-group) image to whichever open photo request it fulfills, if any.
 * Returns false when this sender has no matching request — the caller falls through to the
 * ordinary conversation flow, since not every image sent to this number is a seller answering
 * Fi's own photo request.
 *
 * Every image in a multi-photo reply is forwarded to the requester as it arrives; only the
 * FIRST one also triggers the match-summary resend, so a seller's 3-6 photos don't each
 * re-send the whole card.
 */
export async function handleIncomingSellerPhoto(fromPhone: string, imageUrl: string): Promise<boolean> {
  const record = await findPendingPhotoRequestByContactPhone(fromPhone);
  if (!record || !record.requesterPhone) return false;

  const wasFirstPhoto = record.status === "requested";
  await appendReceivedPhoto(record.source, record.type, record.externalId, imageUrl);
  await sendBannerImage(record.requesterPhone, imageUrl);

  if (wasFirstPhoto) {
    const listing = await getListingByKey(record.source, record.type, record.externalId);
    if (listing) {
      const displayIndex = (Number(record.matchId) || 1) - 1;
      // Best-effort, same isolation as flow.ts's own use of this lookup — a failure here must
      // never block resending the match card, it just omits the line.
      const activeGroupCount = await getActiveGroupCountForContact(listing.contactPhone).catch((err) => {
        console.error(`[photoRequests] active-group lookup failed for ${listing.contactPhone} (omitting from card):`, err);
        return 0;
      });
      await sendText(record.requesterPhone, "Photos received — here's the match again:");
      await sendText(record.requesterPhone, formatMatchCard(listing, displayIndex, "buy", undefined, undefined, undefined, activeGroupCount));
    }
  }

  return true;
}
