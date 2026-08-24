/**
 * Normalizes Green API's `incomingMessageReceived` webhook payload into the
 * shape the rest of the app works with. Other webhook types (message status
 * updates, outgoing message echoes, etc.) are ignored by returning null.
 *
 * Reference: https://green-api.com/en/docs/api/receiving/notifications-format/
 */

export interface NormalizedMessage {
  whatsappMsgId: string;
  chatId: string; // group id (@g.us) or the DM chat id (@c.us)
  senderId: string; // the individual sender, even inside a group
  senderName: string | null;
  chatName: string | null; // group name, when isGroup
  text: string;
  isGroup: boolean;
  timestamp: Date;
}

interface GreenApiSenderData {
  chatId: string;
  sender: string;
  senderName?: string;
  chatName?: string;
}

interface GreenApiMessageData {
  typeMessage: string;
  textMessageData?: { textMessage: string };
  extendedTextMessageData?: { text: string };
}

interface GreenApiWebhookBody {
  typeWebhook: string;
  idMessage?: string;
  timestamp?: number;
  senderData?: GreenApiSenderData;
  messageData?: GreenApiMessageData;
}

export function normalizeGreenApiWebhook(body: unknown): NormalizedMessage | null {
  const payload = body as GreenApiWebhookBody;

  if (!payload || payload.typeWebhook !== "incomingMessageReceived") {
    return null;
  }

  const { senderData, messageData } = payload;
  if (!senderData || !messageData) return null;

  const text = messageData.textMessageData?.textMessage ?? messageData.extendedTextMessageData?.text ?? null;
  if (!text) return null; // ignore media/system messages — Fi only reads text listings/commands

  const chatId = senderData.chatId;
  const isGroup = chatId.endsWith("@g.us");

  return {
    whatsappMsgId: payload.idMessage ?? `${chatId}-${payload.timestamp ?? Date.now()}`,
    chatId,
    senderId: senderData.sender || chatId,
    senderName: senderData.senderName ?? null,
    chatName: senderData.chatName ?? null,
    text,
    isGroup,
    timestamp: payload.timestamp ? new Date(payload.timestamp * 1000) : new Date(),
  };
}
