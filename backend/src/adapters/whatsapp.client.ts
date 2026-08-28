import crypto from 'crypto';
import { Pool } from 'pg';
import { MessagingAdapter, OutboundMessage, SendResult } from './messaging.adapter';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? 'v20.0';

/**
 * Real WhatsApp transport via Meta's WhatsApp Cloud API (spec: this session's
 * MVP focus). Outbound sends look up the recipient's WhatsApp phone number
 * from platform_identities (the OutboundMessage only carries a canonical user
 * id, never a phone number, so the DB lookup lives here rather than forcing
 * every caller to know about phone numbers).
 */
export class WhatsAppCloudAdapter implements MessagingAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly accessToken: string,
    private readonly phoneNumberId: string
  ) {}

  private async resolvePhoneNumber(canonicalUserId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT platform_user_id FROM platform_identities
       WHERE canonical_user_id = $1 AND platform = 'whatsapp'
       ORDER BY created_at DESC LIMIT 1`,
      [canonicalUserId]
    );
    return rows[0]?.platform_user_id ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = await this.resolvePhoneNumber(message.recipientCanonicalUserId);
    if (!to) {
      return { ok: false, error: `no WhatsApp identity on file for canonical user ${message.recipientCanonicalUserId}` };
    }

    const payload = this.buildPayload(to, message);
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `WhatsApp API ${res.status}: ${body}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * WhatsApp interactive button messages cap at 3 buttons and can't carry an
   * image + buttons in one message the way the spec's suggested format shows
   * (spec 9.1 already accounts for this: send the image+summary, then the
   * linked Approve/Pass message, tied to the same match).
   */
  private buildPayload(to: string, message: OutboundMessage): Record<string, unknown> {
    if (message.imageUrl) {
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: message.imageUrl, caption: message.text },
      };
    }
    if (message.buttons && message.buttons.length > 0) {
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.text },
          action: {
            buttons: message.buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.action, title: b.label },
            })),
          },
        },
      };
    }
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message.text },
    };
  }
}

/** Constructs a live adapter only when the required env vars are all present. */
export function getWhatsAppAdapterIfConfigured(pool: Pool): WhatsAppCloudAdapter | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return new WhatsAppCloudAdapter(pool, accessToken, phoneNumberId);
}

/**
 * Verifies Meta's X-Hub-Signature-256 header against the exact raw request
 * body using the app secret (constant-time compare). Never accept an
 * unverified webhook body -- WHATSAPP_APP_SECRET must be set for the webhook
 * to accept anything.
 */
export function verifyWhatsAppSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
