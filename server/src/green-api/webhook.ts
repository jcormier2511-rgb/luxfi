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
  imageUrl: string | null; // set when the message is a photo — `text` is then its caption (may be empty)
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
  fileMessageData?: { downloadUrl: string; caption?: string; mimeType?: string };
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

  let text: string | null;
  let imageUrl: string | null = null;

  if (messageData.typeMessage === "imageMessage" && messageData.fileMessageData) {
    imageUrl = messageData.fileMessageData.downloadUrl;
    text = messageData.fileMessageData.caption ?? ""; // listings need a caption; a bare photo is stored but not parsed
  } else {
    text = messageData.textMessageData?.textMessage ?? messageData.extendedTextMessageData?.text ?? null;
  }
  if (text === null) return null; // ignore other media/system message types — Fi only reads text and captioned photos

  const chatId = senderData.chatId;
  const isGroup = chatId.endsWith("@g.us");

  return {
    whatsappMsgId: payload.idMessage ?? `${chatId}-${payload.timestamp ?? Date.now()}`,
    chatId,
    senderId: senderData.sender || chatId,
    senderName: senderData.senderName ?? null,
    chatName: senderData.chatName ?? null,
    text,
    imageUrl,
    isGroup,
    timestamp: payload.timestamp ? new Date(payload.timestamp * 1000) : new Date(),
  };
}
