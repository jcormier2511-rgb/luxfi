import type { Dealer } from "@prisma/client";
import { prisma } from "../db.js";
import { findDealerByNameLike } from "./dealerService.js";
import { getReviewProfile, requestVouch, tryFulfillVouchReply } from "./reviewService.js";
import { sendDirectMessage } from "../green-api/client.js";
import { config } from "../config.js";
import {
  HELP_TEXT,
  formatReviewProfileReply,
  formatVouchReceivedNotice,
  formatVouchRequestSentConfirmation,
  formatVouchRequestToTarget,
} from "../messaging/templates.js";

const CHECK_REVIEWS_PATTERN = /check\s+reviews?\s+for\s+@?(\S+)/i;
const REQUEST_REVIEW_PATTERN = /request\s+(?:a\s+)?review\s+from\s+@?(\S+)(?:\s+for\s+(?:the\s+)?(.+?)\s+deal)?\s*$/i;
const GREETING_PATTERN = /^(start|hi|hello)\b/i;
const BALANCE_PATTERN = /\b(balance|credits)\b/i;

/**
 * Handles a 1:1 DM sent to Fi (as opposed to a group message, which is
 * monitored for WTB/FS listings instead). Returns the reply text to send
 * back to the sender.
 */
export async function handleDmMessage(sender: Dealer, text: string): Promise<string> {
  const vouch = await tryFulfillVouchReply(sender, text);
  if (vouch) {
    const requester = await prisma.dealer.findUnique({ where: { id: vouch.requesterDealerId } });
    if (requester) {
      await sendDirectMessage(requester.whatsappId, formatVouchReceivedNotice(sender.name ?? "a dealer", vouch.rating));
    }
    return "Thanks — your vouch has been recorded.";
  }

  if (GREETING_PATTERN.test(text.trim())) {
    return `Fi is live and monitoring your groups.\n\n${HELP_TEXT}`;
  }

  const checkMatch = text.match(CHECK_REVIEWS_PATTERN);
  if (checkMatch?.[1]) {
    const target = await findDealerByNameLike(checkMatch[1]);
    if (!target) return `Couldn't find a dealer matching "${checkMatch[1]}" yet.`;
    const profile = await getReviewProfile(target.id);
    return formatReviewProfileReply(checkMatch[1], profile);
  }

  const requestMatch = text.match(REQUEST_REVIEW_PATTERN);
  if (requestMatch?.[1]) {
    const target = await findDealerByNameLike(requestMatch[1]);
    if (!target) return `Couldn't find a dealer matching "${requestMatch[1]}" yet.`;
    const dealText = requestMatch[2]?.trim() ?? null;
    await requestVouch(sender, target, dealText);
    await sendDirectMessage(target.whatsappId, formatVouchRequestToTarget(sender.name ?? "A dealer", dealText));
    return formatVouchRequestSentConfirmation(target.name ?? requestMatch[1]);
  }

  if (BALANCE_PATTERN.test(text)) {
    const freeLeft = Math.max(0, config.matching.freeMatchesPerDealer - sender.freeMatchesUsed);
    return `You have ${sender.credits} credits (${freeLeft} free matches remaining).`;
  }

  return HELP_TEXT;
}
