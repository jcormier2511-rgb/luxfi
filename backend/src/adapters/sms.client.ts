import crypto from 'crypto';
import { Pool } from 'pg';
import { MessagingAdapter, OutboundMessage, SendResult } from './messaging.adapter';

const DEFAULT_API_BASE = 'https://api.twilio.com';

/**
 * Real SMS/MMS transport via Twilio's REST API. SMS has no native
 * button/interactive-reply mechanism, so OutboundMessage.buttons are
 * rendered as a plain-text reply instruction instead: the contact texts back
 * a word ("APPROVE"/"PASS") and routes/sms.routes.ts resolves that against
 * the recipient's single most recent pending match, rather than an embedded
 * button id the way WhatsApp/Telegram's interactive replies work.
 */
export class TwilioSmsAdapter implements MessagingAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly apiBaseUrl: string = DEFAULT_API_BASE
  ) {}

  private async resolvePhoneNumber(canonicalUserId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT platform_user_id FROM platform_identities
       WHERE canonical_user_id = $1 AND platform = 'sms'
       ORDER BY created_at DESC LIMIT 1`,
      [canonicalUserId]
    );
    return rows[0]?.platform_user_id ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = await this.resolvePhoneNumber(message.recipientCanonicalUserId);
    if (!to) {
      return { ok: false, error: `no SMS identity on file for canonical user ${message.recipientCanonicalUserId}` };
    }

    const params = new URLSearchParams({ To: to, From: this.fromNumber, Body: this.renderBody(message) });
    if (message.imageUrl) params.set('MediaUrl', message.imageUrl);

    try {
      const res = await fetch(`${this.apiBaseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { ok: false, error: `Twilio API ${res.status}: ${errBody}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private renderBody(message: OutboundMessage): string {
    if (!message.buttons || message.buttons.length === 0) return message.text;
    const options = message.buttons.map((b) => `Reply "${b.label}"`).join(' or ');
    return `${message.text}\n\n${options}`;
  }
}

/** Constructs a live adapter only when all required Twilio env vars are present. */
export function getSmsAdapterIfConfigured(pool: Pool): TwilioSmsAdapter | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return new TwilioSmsAdapter(pool, accountSid, authToken, fromNumber, process.env.TWILIO_API_BASE_URL || DEFAULT_API_BASE);
}

/**
 * Verifies Twilio's X-Twilio-Signature header: HMAC-SHA1 over the full
 * request URL with all POST params sorted by key and concatenated as
 * key+value pairs (Twilio's documented algorithm), keyed by the auth token,
 * base64-encoded. Never accept an unverified inbound SMS webhook.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
  authToken: string
): boolean {
  if (!signatureHeader) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
