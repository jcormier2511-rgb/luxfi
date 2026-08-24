import { prisma } from "./db.js";
import type { NormalizedMessage } from "./green-api/webhook.js";
import { findOrCreateDealer } from "./domain/dealerService.js";
import { findOrCreateGroup } from "./domain/groupService.js";
import { createListing } from "./domain/listingService.js";
import { attemptMatch } from "./domain/matchingService.js";
import { parseListing } from "./parsing/listingParser.js";
import { handleDmMessage } from "./domain/commandRouter.js";
import { sendDirectMessage } from "./green-api/client.js";

/**
 * Entry point for every normalized incoming WhatsApp message, whether it
 * came from a live Green API webhook or the dev /simulate/message endpoint.
 *
 * Group messages are only ever read — Fi extracts listings and DMs the
 * relevant dealers, but never posts back into the group. DMs to Fi are
 * routed through the command router instead.
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
  const parsed = parseListing(msg.text);
  if (!parsed) return; // not a WTB/FS post — ignore silently, as Fi never posts to groups

  const group = await findOrCreateGroup(msg.chatId, msg.chatName);
  const listing = await createListing(parsed, { dealerId, groupId: group.id, rawText: msg.text });
  await attemptMatch(listing);
}
