import { prisma } from "./db.js";
import type { NormalizedMessage } from "./green-api/webhook.js";
import { findOrCreateDealer } from "./domain/dealerService.js";
import { findOrCreateGroup } from "./domain/groupService.js";
import { createListing } from "./domain/listingService.js";
import { attemptMatch } from "./domain/matchingService.js";
import { runListingChecks } from "./domain/verificationService.js";
import { extractListing } from "./llm/listingExtractor.js";
import { handleDmMessage } from "./llm/dmAgent.js";
import { sendDirectMessage } from "./green-api/client.js";

/**
 * Entry point for every normalized incoming WhatsApp message, whether it
 * came from a live Green API webhook or the dev /simulate/message endpoint.
 *
 * Group messages are only ever read — Claude decides whether the message is
 * a WTB/FS listing, and if so Fi extracts it and DMs the relevant dealers,
 * but never posts back into the group. DMs to Fi are handled by Claude
 * directly instead of a fixed command grammar.
 */
export async function handleIncomingMessage(msg: NormalizedMessage): Promise<void> {
  const existing = await prisma.rawMessage.findUnique({ where: { whatsappMsgId: msg.whatsappMsgId } });
  if (existing) return; // dedupe re-delivered webhooks

  await prisma.rawMessage.create({
    data: {
      whatsappMsgId: msg.whatsappMsgId,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
      isGroup: msg.isGroup,
      timestamp: msg.timestamp,
    },
  });

  const dealer = await findOrCreateDealer(msg.senderId, msg.senderName);

  if (msg.isGroup) {
    await handleGroupMessage(msg, dealer.id);
    return;
  }

  const reply = await handleDmMessage(dealer, msg.text);
  await sendDirectMessage(dealer.whatsappId, reply);
}

async function handleGroupMessage(msg: NormalizedMessage, dealerId: string): Promise<void> {
  const parsed = await extractListing(msg.text);
  if (!parsed) return; // not a WTB/FS post — ignore silently, as Fi never posts to groups

  const group = await findOrCreateGroup(msg.chatId, msg.chatName);
  let listing = await createListing(parsed, { dealerId, groupId: group.id, rawText: msg.text, imageUrl: msg.imageUrl });
  listing = await runListingChecks(listing);
  await attemptMatch(listing);
}
