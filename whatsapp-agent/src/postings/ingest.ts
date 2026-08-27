import { ingestChatPosting, ChatPostingInput, mirrorApiFsPosting, markApiPostingsInactive, ApiFsListing } from "./postingsStore";
import { runImmediateMatch } from "./matching";
import { sendText } from "../whapi/client";

/**
 * Spec §4.1/§4.2: a new or materially-changed posting is immediately tested against every
 * eligible opposite-side posting; if nothing matches, the poster gets a private
 * acknowledgment rather than silence. Re-editing a message that still finds nothing doesn't
 * re-send the acknowledgment — only a brand-new posting with zero matches does.
 */
export async function ingestAndMatch(input: ChatPostingInput): Promise<void> {
  const result = await ingestChatPosting(input);
  if (!result.posting) return; // text didn't classify as FS/WTB — ignore silently, same as before

  if (!result.materialChange) return;

  const { matchesFound } = await runImmediateMatch(result.posting);
  if (matchesFound === 0 && result.created) {
    try {
      await sendText(
        input.senderIdentity,
        "I'm monitoring this request. I'll let you know automatically when I find a qualifying buyer or seller."
      );
    } catch (err) {
      console.error(`[postings] failed to send monitoring acknowledgment to ${input.senderIdentity}:`, err);
    }
  }
}

/**
 * Single entry point for what a successful WatchFacts FS sync must do to the v4 matching
 * system (spec requirement: "every successful sync must trigger reverse matching of new or
 * materially updated FS listings against all active chat-originated WTB monitors"). Reuses
 * the exact same mirrorApiFsPosting/runImmediateMatch/notifyMatch pipeline the chat-ingestion
 * path uses — matching is one shared engine over the one `postings` table, not a second,
 * source-specific matching implementation. An unchanged re-sync of an already-known listing
 * (materialChange: false) is a no-op here, same as an unedited chat-message redelivery,
 * so a routine sync never re-notifies anyone about a listing nothing actually changed on.
 */
export async function ingestApiFsSync(listings: ApiFsListing[]): Promise<void> {
  for (const listing of listings) {
    const { posting, materialChange } = await mirrorApiFsPosting(listing);
    if (materialChange) {
      await runImmediateMatch(posting);
    }
  }
  await markApiPostingsInactive(listings.map((l) => l.id));
}
