import crypto from 'crypto';
import { Pool } from 'pg';
import { MessagingAdapter, OutboundMessage, SendResult } from './messaging.adapter';

const DEFAULT_API_BASE = 'https://api.telegram.org';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; username?: string };
    data?: string;
  };
}

/**
 * Real Telegram transport via the Bot API. Outbound sends look up the
 * recipient's Telegram chat id from platform_identities -- OutboundMessage
 * only ever carries a canonical user id, never a platform-specific address,
 * matching WhatsAppCloudAdapter's resolution pattern (whatsapp.client.ts).
 */
export class TelegramBotAdapter implements MessagingAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly botToken: string,
    private readonly apiBaseUrl: string = DEFAULT_API_BASE
  ) {}

  private async resolveChatId(canonicalUserId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT platform_user_id FROM platform_identities
       WHERE canonical_user_id = $1 AND platform = 'telegram'
       ORDER BY created_at DESC LIMIT 1`,
      [canonicalUserId]
    );
    return rows[0]?.platform_user_id ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const chatId = await this.resolveChatId(message.recipientCanonicalUserId);
    if (!chatId) {
      return { ok: false, error: `no Telegram identity on file for canonical user ${message.recipientCanonicalUserId}` };
    }

    const method = message.imageUrl ? 'sendPhoto' : 'sendMessage';
    const payload = this.buildPayload(chatId, message);
    try {
      const res = await fetch(`${this.apiBaseUrl}/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { ok: false, error: `Telegram API ${res.status}: ${errBody}` };
      }
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        return { ok: false, error: json.description ?? 'Telegram API returned ok:false' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Telegram's inline keyboard is the closest analog to WhatsApp's interactive buttons. */
  private buildPayload(chatId: string, message: OutboundMessage): Record<string, unknown> {
    const replyMarkup =
      message.buttons && message.buttons.length > 0
        ? { inline_keyboard: [message.buttons.map((b) => ({ text: b.label, callback_data: b.action }))] }
        : undefined;

    if (message.imageUrl) {
      return {
        chat_id: chatId,
        photo: message.imageUrl,
        caption: message.text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      };
    }
    return {
      chat_id: chatId,
      text: message.text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
  }
}

/** Constructs a live adapter only when the required env var is present. */
export function getTelegramAdapterIfConfigured(pool: Pool): TelegramBotAdapter | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;
  return new TelegramBotAdapter(pool, botToken, process.env.TELEGRAM_API_BASE_URL || DEFAULT_API_BASE);
}

/**
 * Telegram webhooks carry no HMAC-signed body. The documented way to
 * authenticate an inbound call is a secret token chosen when registering the
 * webhook (Bot API's setWebhook secret_token param), echoed back on every
 * call in the X-Telegram-Bot-Api-Secret-Token header -- constant-time
 * compare, same discipline as WhatsApp's HMAC check (verifyWhatsAppSignature).
 */
export function verifyTelegramSecret(headerValue: string | undefined, expectedSecret: string): boolean {
  if (!headerValue) return false;
  const provided = Buffer.from(headerValue);
  const expected = Buffer.from(expectedSecret);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}
