import { ingestChatPosting, ChatPostingInput } from "./postingsStore";
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
