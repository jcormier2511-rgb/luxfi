import { Pool } from 'pg';
import { MessagingAdapter, OutboundMessage, SendResult } from './messaging.adapter';
import { Platform } from '../types/domain';

/** Richest/most conversational experience first; email is the last resort. */
const CHANNEL_PRIORITY: Platform[] = ['whatsapp', 'telegram', 'sms', 'email'];

/**
 * Fans an outbound message out to whichever real per-channel adapter matches
 * the recipient's best available identity. A canonical user can arrive via
 * any platform (or several); `adapters` only contains entries for channels
 * whose credentials are actually configured (see server.ts), so a channel
 * with no credentials is simply absent and skipped here rather than erroring.
 */
export class MultiChannelAdapter implements MessagingAdapter {
  constructor(
    private readonly pool: Pool,
    private readonly adapters: Partial<Record<Platform, MessagingAdapter>>
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const { rows } = await this.pool.query<{ platform: Platform }>(
      'SELECT DISTINCT platform FROM platform_identities WHERE canonical_user_id = $1',
      [message.recipientCanonicalUserId]
    );
    const available = new Set(rows.map((r) => r.platform));

    let lastError: string | undefined;
    for (const platform of CHANNEL_PRIORITY) {
      if (!available.has(platform)) continue;
      const adapter = this.adapters[platform];
      if (!adapter) continue;
      const result = await adapter.send(message);
      if (result.ok) return result;
      lastError = result.error;
    }
    return {
      ok: false,
      error: lastError ?? `no configured messaging channel available for canonical user ${message.recipientCanonicalUserId}`,
    };
  }
}
