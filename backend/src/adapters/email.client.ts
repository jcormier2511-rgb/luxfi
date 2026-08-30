import { Pool } from 'pg';
import { MessagingAdapter, OutboundMessage, SendResult } from './messaging.adapter';

const DEFAULT_API_BASE = 'https://api.sendgrid.com';

/**
 * Outbound-only email transport via SendGrid's v3 mail-send API. Email is a
 * reach-out channel, not a conversational one in this MVP: there's no inbound
 * webhook/route for it (routes/ only has one for telegram and sms), so an
 * Approve/Pass action is rendered as a plain-text instruction to reply on
 * whichever other channel the recipient also has on file, same spirit as SMS
 * (sms.client.ts) since email has no native button mechanism either.
 */
export class SendGridEmailAdapter implements MessagingAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly apiKey: string,
    private readonly fromAddress: string,
    private readonly apiBaseUrl: string = DEFAULT_API_BASE
  ) {}

  private async resolveEmailAddress(canonicalUserId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT platform_user_id FROM platform_identities
       WHERE canonical_user_id = $1 AND platform = 'email'
       ORDER BY created_at DESC LIMIT 1`,
      [canonicalUserId]
    );
    return rows[0]?.platform_user_id ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const to = await this.resolveEmailAddress(message.recipientCanonicalUserId);
    if (!to) {
      return { ok: false, error: `no email identity on file for canonical user ${message.recipientCanonicalUserId}` };
    }

    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: this.fromAddress },
      subject: 'Fi -- update on your listing',
      content: [{ type: 'text/plain', value: this.renderBody(message) }],
    };

    try {
      const res = await fetch(`${this.apiBaseUrl}/v3/mail/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { ok: false, error: `SendGrid API ${res.status}: ${errBody}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private renderBody(message: OutboundMessage): string {
    const lines = [message.text];
    if (message.imageUrl) lines.push(`Image: ${message.imageUrl}`);
    if (message.buttons && message.buttons.length > 0) {
      lines.push('', ...message.buttons.map((b) => `- ${b.label}: reply to this email with "${b.label}"`));
    }
    return lines.join('\n');
  }
}

/** Constructs a live adapter only when the required SendGrid env vars are present. */
export function getEmailAdapterIfConfigured(pool: Pool): SendGridEmailAdapter | null {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromAddress = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !fromAddress) return null;
  return new SendGridEmailAdapter(pool, apiKey, fromAddress, process.env.SENDGRID_API_BASE_URL || DEFAULT_API_BASE);
}
