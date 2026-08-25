import { config } from "../config";

function baseUrl(method: string): string {
  const { baseUrl, idInstance, tokenInstance } = config.greenApi;
  return `${baseUrl}/waInstance${idInstance}/${method}/${tokenInstance}`;
}

function chatIdFor(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `${digits}@c.us`;
}

async function post(method: string, body: unknown): Promise<any> {
  if (!config.greenApi.idInstance || !config.greenApi.tokenInstance) {
    console.warn(
      `[greenapi] GREEN_API_ID_INSTANCE/GREEN_API_TOKEN_INSTANCE not set — skipping live call to ${method}. Payload:`,
      body
    );
    return { simulated: true };
  }
  const res = await fetch(baseUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GreenAPI ${method} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function sendText(phone: string, message: string): Promise<void> {
  await post("sendMessage", {
    chatId: chatIdFor(phone),
    message,
  });
}

export async function sendBannerImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await post("sendFileByUrl", {
    chatId: chatIdFor(phone),
    urlFile: imageUrl,
    fileName: "luxfi-banner.jpg",
    caption: caption ?? "",
  });
}

/**
 * Shape of the "incomingMessageReceived" webhook body GreenAPI POSTs when a
 * webhookUrl is configured on the instance (Settings > setSettings, or via console).
 * Only the fields the bot actually reads are typed here.
 */
export interface IncomingWebhook {
  typeWebhook: string;
  idMessage?: string;
  senderData?: {
    chatId: string;
    sender: string;
    senderName?: string;
  };
  messageData?: {
    typeMessage: string;
    textMessageData?: { textMessage: string };
    extendedTextMessageData?: { text: string };
  };
}

export function extractIncomingText(body: IncomingWebhook): { phone: string; text: string } | null {
  if (body.typeWebhook !== "incomingMessageReceived") return null;
  const chatId = body.senderData?.chatId ?? body.senderData?.sender;
  if (!chatId) return null;
  const phone = chatId.replace("@c.us", "");
  const text =
    body.messageData?.textMessageData?.textMessage ??
    body.messageData?.extendedTextMessageData?.text ??
    "";
  if (!text) return null;
  return { phone, text };
}
