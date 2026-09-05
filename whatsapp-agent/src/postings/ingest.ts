import {
  ingestChatPosting,
  ChatPostingInput,
  mirrorApiPosting,
  markApiPostingsInactive,
  ApiFsListing,
  createDirectPosting,
  DirectSellPostingInput,
  PostingRow,
} from "./postingsStore";
import { runImmediateMatch } from "./matching";
import { sendText } from "../channels";
import { publishConfirmedListing } from "./groupPublishing";
import { fulfillWtb } from "../fulfillment/service";

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

  const { matchesFound } = result.posting.type === "WTB" ? { matchesFound: (await fulfillWtb(result.posting)).explicitMatches } : await runImmediateMatch(result.posting);
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

export interface DirectSellIngestResult {
  matchesFound: number;
  posting: PostingRow;
}

/**
 * Fi's own "sell a watch" conversational intake (conversation/flow.ts) completing, not a
 * passively-monitored group message — creates a real, always-active FS posting and runs it
 * against every eligible active WTB posting immediately, same shared matching engine
 * (runImmediateMatch/notifyMatch) the chat-ingestion and WatchFacts-sync paths already use.
 * Never sends its own "I'm monitoring this" acknowledgment (unlike ingestAndMatch above) — the
 * caller already sends its own item/price/photo summary in the same conversation turn; the
 * returned matchesFound count lets it fold the outcome into that one message instead of
 * stacking a second, redundant one. A found match's own notification (to either side) still
 * goes out via notifyMatch/sendText exactly as it does for any other posting.
 */
export async function ingestDirectSellPosting(input: DirectSellPostingInput): Promise<DirectSellIngestResult> {
  const posting = await createDirectPosting(input);
  await publishConfirmedListing(posting);
  const { matchesFound } = posting.type === "WTB" ? { matchesFound: (await fulfillWtb(posting)).explicitMatches } : await runImmediateMatch(posting);
  return { matchesFound, posting };
}

/** Saves a completed private buyer request before attempting any inventory search. */
export async function ingestDirectBuyPosting(input: DirectSellPostingInput): Promise<DirectSellIngestResult> {
  const posting = await createDirectPosting({ ...input, type: "WTB" });
  await publishConfirmedListing(posting);
  const { explicitMatches: matchesFound } = await fulfillWtb(posting);
  return { matchesFound, posting };
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
  // Sequential by design (each posting's match check depends on the postings table reflecting
  // every prior one in this same batch), but that means a large batch is otherwise silent for
  // however long it takes — the very first sync against a real feed processes every "new to
  // this table" listing at once (tens of thousands), which can take a long time with nothing
  // to distinguish "still working" from "hung". Logged every 500 rows and at the end so a long
  // run is visible in Deploy Logs rather than looking indistinguishable from a stuck process.
  const started = Date.now();
  let materialChanges = 0;
  for (let i = 0; i < listings.length; i++) {
    const { posting, materialChange } = await mirrorApiPosting(listings[i], "FS");
    if (materialChange) {
      materialChanges++;
      await runImmediateMatch(posting);
    }
    if ((i + 1) % 500 === 0) {
      console.log(`[postings] ingestApiFsSync: ${i + 1}/${listings.length} (${materialChanges} material changes, ${Math.round((Date.now() - started) / 1000)}s elapsed)`);
    }
  }
  await markApiPostingsInactive("FS", listings.map((l) => l.id));
  console.log(`[postings] ingestApiFsSync: done — ${listings.length} listings, ${materialChanges} material changes, ${Math.round((Date.now() - started) / 1000)}s total`);
}

/**
 * WTB counterpart to ingestApiFsSync above — same reasoning, same shared runImmediateMatch
 * engine, just the other direction: a new or materially-changed WatchFacts dealer buy request
 * mirrored into `postings` is tested against every active chat-originated (and API-mirrored) FS
 * posting, so a real seller can actually be matched/notified against real WatchFacts demand
 * instead of that demand only ever showing up in read-only displays (Market Pulse/Guide, "show
 * current listings"). Deliberately does NOT also run fulfillment/service.ts's fulfillWtb — that
 * additionally pushes an outbound "can you fulfill this?" message to every covering dealer, which
 * would mean auto-messaging real third-party dealers on every routine sync; that's a materially
 * bigger, separate decision than "let existing matching notice this demand," left for later.
 */
export async function ingestApiWtbSync(listings: ApiFsListing[]): Promise<void> {
  const started = Date.now();
  let materialChanges = 0;
  for (let i = 0; i < listings.length; i++) {
    const { posting, materialChange } = await mirrorApiPosting(listings[i], "WTB");
    if (materialChange) {
      materialChanges++;
      await runImmediateMatch(posting);
    }
    if ((i + 1) % 500 === 0) {
      console.log(`[postings] ingestApiWtbSync: ${i + 1}/${listings.length} (${materialChanges} material changes, ${Math.round((Date.now() - started) / 1000)}s elapsed)`);
    }
  }
  await markApiPostingsInactive("WTB", listings.map((l) => l.id));
  console.log(`[postings] ingestApiWtbSync: done — ${listings.length} listings, ${materialChanges} material changes, ${Math.round((Date.now() - started) / 1000)}s total`);
}
