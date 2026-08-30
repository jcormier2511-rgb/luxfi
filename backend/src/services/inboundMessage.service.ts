import { Pool } from 'pg';
import { Platform } from '../types/domain';
import { getMessagingAdapter } from '../adapters/messaging.adapter';
import { getMessageExtractor } from '../adapters/aiExtraction.client';
import { ingestAndProcessChatPosting } from './chatIngestion.service';
import { resolveCanonicalUserForPlatformIdentity } from './canonicalUser.service';
import { approveMatch, passMatch, confirmCounterparty } from './approval.service';
import { acknowledgeKeepWorking } from './conversation.service';
import { extendPosting, findPostingsAwaitingExtensionForUser } from './posting.service';
import { findMostRecentApprovedMatchForUser, getVouchSummary, requestVouch, respondToVouch } from './vouch.service';

export const JOIN_COMMAND = /^join$/i;
export const EXTEND_COMMAND = /^extend$/i;
export const REQUEST_REVIEW_COMMAND = /^(request review|review me|review)$/i;
export const CHECK_REVIEWS_COMMAND = /^(reviews|my reviews)$/i;

function isRecognizedCommand(body: string): boolean {
  return JOIN_COMMAND.test(body) || EXTEND_COMMAND.test(body) || REQUEST_REVIEW_COMMAND.test(body) || CHECK_REVIEWS_COMMAND.test(body);
}

async function handleRequestReviewCommand(pool: Pool, canonicalUserId: string): Promise<void> {
  const matchId = await findMostRecentApprovedMatchForUser(pool, canonicalUserId);
  if (!matchId) {
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "I don't see a completed deal to request a review for yet.",
    });
    return;
  }
  const result = await requestVouch(pool, matchId, canonicalUserId);
  if (result.status === 'requested') {
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: 'Found your recent deal -- vouch request sent.',
    });
  } else if (result.status === 'already_requested') {
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "I've already asked them for a review on that deal.",
    });
  }
}

async function handleCheckReviewsCommand(pool: Pool, canonicalUserId: string): Promise<void> {
  const { positiveVouchCount } = await getVouchSummary(pool, canonicalUserId);
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text:
      positiveVouchCount === 0
        ? "You don't have any reviews yet."
        : `You have ${positiveVouchCount} positive review${positiveVouchCount === 1 ? '' : 's'}.`,
  });
}

async function handleExtendCommand(pool: Pool, canonicalUserId: string): Promise<void> {
  const pending = await findPostingsAwaitingExtensionForUser(pool, canonicalUserId);
  if (pending.length === 0) {
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "I don't see a monitor waiting on an extension right now.",
    });
    return;
  }
  for (const posting of pending) {
    await extendPosting(pool, posting.id);
  }
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: `Extended! ${pending.length === 1 ? 'Your monitor' : `All ${pending.length} of your monitors`} will stay active for another 30 days.`,
  });
}

/**
 * Platform-agnostic inbound text handling shared by every conversational
 * channel's webhook route: WhatsApp, Telegram, and SMS all funnel through the
 * same command/posting-ingestion pipeline here (spec 5.1/9-10). Only payload
 * parsing and transport verification differ per channel -- see
 * routes/whatsapp.routes.ts, routes/telegram.routes.ts, routes/sms.routes.ts.
 */
export async function handleInboundText(
  pool: Pool,
  params: {
    platform: Platform;
    chatId: string;
    messageId: string;
    senderPlatformUserId: string;
    senderDisplayName?: string;
    body: string;
  }
): Promise<void> {
  const body = params.body.trim();
  if (!body) return;

  if (isRecognizedCommand(body)) {
    const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
      platform: params.platform,
      platformUserId: params.senderPlatformUserId,
      displayName: params.senderDisplayName,
    });
    if (JOIN_COMMAND.test(body)) {
      await acknowledgeKeepWorking(canonicalUserId);
    } else if (EXTEND_COMMAND.test(body)) {
      await handleExtendCommand(pool, canonicalUserId);
    } else if (REQUEST_REVIEW_COMMAND.test(body)) {
      await handleRequestReviewCommand(pool, canonicalUserId);
    } else if (CHECK_REVIEWS_COMMAND.test(body)) {
      await handleCheckReviewsCommand(pool, canonicalUserId);
    }
    return;
  }

  const parsed = await getMessageExtractor().extract(body);
  if (!parsed) return; // not recognizable as a command or an FS/WTB post -- leave it alone

  await ingestAndProcessChatPosting(pool, {
    sourceType: 'chat',
    platform: params.platform,
    chatId: params.chatId,
    messageId: params.messageId,
    postingType: parsed.postingType,
    originalMessage: body,
    senderPlatformUserId: params.senderPlatformUserId,
    senderDisplayName: params.senderDisplayName,
    brand: parsed.brand,
    model: parsed.model,
    referenceNumber: parsed.referenceNumber,
    dial: parsed.dial,
    material: parsed.material,
    year: parsed.year,
    condition: parsed.condition,
    boxPapers: parsed.boxPapers,
    askingPrice: parsed.askingPrice,
    maxBid: parsed.maxBid,
    currency: parsed.currency,
    location: parsed.location,
    country: parsed.country,
  });
}

/**
 * Handles a button/interactive-reply action (WhatsApp button, Telegram
 * callback_query, or an SMS text reply resolved to an action by the caller)
 * once the sender's canonical user id is already known.
 */
export async function handleButtonAction(
  pool: Pool,
  canonicalUserId: string,
  action: string | undefined,
  actionArg: string | undefined
): Promise<void> {
  if (action === 'keep-working') {
    await acknowledgeKeepWorking(canonicalUserId);
    return;
  }
  if (!action || !actionArg) return;

  if (action === 'approve') {
    await approveMatch(pool, actionArg, canonicalUserId);
  } else if (action === 'pass') {
    await passMatch(pool, actionArg, canonicalUserId);
  } else if (action === 'confirm-share') {
    await confirmCounterparty(pool, actionArg, canonicalUserId, true);
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "Thanks -- I've shared your contact details.",
    });
  } else if (action === 'decline-share') {
    await confirmCounterparty(pool, actionArg, canonicalUserId, false);
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: 'No problem -- your contact details were not shared.',
    });
  } else if (action === 'vouch-give') {
    // For these two actions the second token is a vouch id, not a match id.
    await respondToVouch(pool, actionArg, true);
  } else if (action === 'vouch-decline') {
    await respondToVouch(pool, actionArg, false);
  }
}
