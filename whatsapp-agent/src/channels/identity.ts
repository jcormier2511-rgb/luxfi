/**
 * Cross-channel identity prefixing: WhatsApp numbers stay unprefixed (backward compat with
 * every phone number already stored across this codebase — conversation state, canonical
 * users, contacts), while Telegram/SMS get an explicit "<platform>:" prefix. This lets a
 * single opaque identity string keep flowing through the existing phone-keyed machinery
 * unchanged — only the messaging send/receive edges (src/channels/*, src/server.ts) need to
 * know a platform prefix exists at all.
 *
 * Scope: group-chat monitoring (conversation/groupMonitor.ts) supports WhatsApp and Telegram
 * groups/supergroups — SMS has no group concept, so it stays 1:1 conversational messaging only.
 */
export type ChannelPlatform = "whatsapp" | "telegram" | "sms";

const TELEGRAM_PREFIX = "telegram:";
const SMS_PREFIX = "sms:";

export function telegramIdentity(chatId: string): string {
  return `${TELEGRAM_PREFIX}${chatId}`;
}

export function smsIdentity(phoneNumber: string): string {
  return `${SMS_PREFIX}${phoneNumber}`;
}

export function platformForIdentity(identity: string): ChannelPlatform {
  if (identity.startsWith(TELEGRAM_PREFIX)) return "telegram";
  if (identity.startsWith(SMS_PREFIX)) return "sms";
  return "whatsapp";
}

export function telegramChatIdFromIdentity(identity: string): string {
  return identity.slice(TELEGRAM_PREFIX.length);
}

export function smsPhoneFromIdentity(identity: string): string {
  return identity.slice(SMS_PREFIX.length);
}
