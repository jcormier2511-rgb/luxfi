import crypto from "crypto";
import { config } from "../config";
import { telegramIdentity, telegramChatIdFromIdentity } from "./identity";
import { NormalizedIncomingMessage } from "./types";

async function callApi(method: string, body: unknown): Promise<any> {
  if (!config.channels.telegram.botToken) {
    console.warn(`[telegram] TELEGRAM_BOT_TOKEN not set — skipping live call to ${method}. Payload:`, body);
    return { simulated: true };
  }
  const res = await fetch(`${config.channels.telegram.apiBaseUrl}/bot${config.channels.telegram.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

export async function sendText(identity: string, message: string): Promise<void> {
  await callApi("sendMessage", { chat_id: telegramChatIdFromIdentity(identity), text: message });
}

export async function sendBannerImage(identity: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await callApi("sendPhoto", { chat_id: telegramChatIdFromIdentity(identity), photo: imageUrl, caption: caption ?? "" });
}

/**
 * Telegram carries no HMAC-signed body. The documented way to authenticate an inbound webhook
 * is a secret token chosen when registering the webhook (setWebhook's secret_token param),
 * echoed back on every call in the X-Telegram-Bot-Api-Secret-Token header.
 */
export function verifyTelegramSecret(headerValue: string | undefined): boolean {
  const expected = config.channels.telegram.webhookSecret;
  if (!expected || !headerValue) return false;
  const provided = Buffer.from(headerValue);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
}

async function resolveFileUrl(fileId: string): Promise<string> {
  const result = await callApi("getFile", { file_id: fileId });
  const filePath = result?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile returned no file_path");
  return `${config.channels.telegram.apiBaseUrl}/file/bot${config.channels.telegram.botToken}/${filePath}`;
}

/**
 * Normalizes a Telegram Bot API update into the same shape whapi/client.ts's
 * extractIncomingMessages produces, so server.ts's shared message-processing pipeline doesn't
 * need to know which channel a message came from. Group/supergroup chats are routed into the
 * same group-monitoring pipeline WhatsApp groups use (conversation/groupMonitor.ts derives the
 * platform from the sender identity's own prefix, so no separate Telegram-specific handling is
 * needed downstream) — channel posts (no `message`, e.g. a broadcast channel) are still dropped
 * entirely, since there's no individual sender to attribute a listing to. A photo carries only a
 * file_id, so resolving it to a downloadable URL needs an extra getFile call (Telegram's
 * convention; there's no direct photo URL in the update itself).
 */
export async function extractIncomingMessages(update: TelegramUpdate): Promise<NormalizedIncomingMessage[]> {
  const message = update.message;
  if (!message) return [];
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isGroup && message.chat.type !== "private") return [];

  const text = message.text ?? message.caption ?? "";
  const hasPhoto = Boolean(message.photo && message.photo.length > 0);

  if (isGroup) {
    // Group monitoring only ever acts on text it can classify as FS/WTB (see classifyText in
    // groupMonitor.ts) — unlike the private-chat path below, there's no active conversational
    // flow with an "I didn't understand" fallback to forward a content-less message to, so a
    // sticker/bare photo/anonymous-admin post (no `from`) is simply nothing to capture.
    if (!text || !message.from) return [];
  } else if (!text && !hasPhoto && !message.document) {
    // Real reported bug: a document (a .psd, a PDF, any file Telegram didn't compress into a
    // `photo`) sent with no caption during an active step (e.g. sell-intake's "attach a photo?")
    // was silently dropped here entirely — the recipient saw no reply at all, indistinguishable
    // from the bot being stuck. It carries no imageUrl (most document types genuinely aren't a
    // usable photo), but it must still reach the conversation flow as a real, if content-less,
    // message — same as an already-supported uncaptioned photo, which passes through with empty
    // text below and lets the active flow's own "I didn't understand that" fallback respond.
    return [];
  }

  let imageUrl: string | undefined;
  if (message.photo && message.photo.length > 0) {
    // Telegram lists photo sizes smallest-first; the last entry is the largest available.
    const fileId = message.photo[message.photo.length - 1].file_id;
    imageUrl = await resolveFileUrl(fileId).catch((err) => {
      console.error("[telegram] failed to resolve photo URL:", err);
      return undefined;
    });
  }

  return [
    {
      // Telegram's message_id is only unique per chat (each chat's own counter starts near 1),
      // not globally -- the shared alreadyProcessed dedup store needs a namespaced id or two
      // different users' first messages (both id "1") collide, silently dropping the second.
      id: `telegram:${message.chat.id}:${message.message_id}`,
      // A group message's "phone" is the individual sender's own identity (same as WhatsApp's
      // whapi/client.ts: `phone` is always the poster, `groupId` is the group) — chat.id only
      // equals from.id for a private 1:1 chat.
      phone: telegramIdentity(String(isGroup ? message.from!.id : message.chat.id)),
      text,
      isGroup,
      groupId: isGroup ? String(message.chat.id) : undefined,
      senderName: message.from?.first_name ?? message.from?.username,
      imageUrl,
    },
  ];
}
