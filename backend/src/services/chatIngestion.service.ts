import { Pool } from 'pg';
import { ingestChatPosting } from './posting.service';
import { runMatchingForPosting } from './matching.service';
import { sendFirstContactIfNeeded, sendMonitoringAcknowledgment } from './conversation.service';
import { ChatPostingInput } from '../types/domain';

export interface ChatIngestionResult {
  postingId: string;
  canonicalUserId: string;
  created: boolean;
  materiallyChanged: boolean;
  matchCount: number;
}

/**
 * Shared pipeline for any chat-originated FS/WTB posting, regardless of which
 * platform it came from: ingest + idempotency (spec 5.1), first-contact once
 * per account (spec 10), immediate matching (spec 4.1-4.3), and the
 * no-match-yet acknowledgment (spec 4). Both the generic normalized webhook
 * and the real WhatsApp webhook call this same seam.
 */
export async function ingestAndProcessChatPosting(
  pool: Pool,
  input: ChatPostingInput
): Promise<ChatIngestionResult> {
  const { posting, created, materiallyChanged } = await ingestChatPosting(pool, input);
  await sendFirstContactIfNeeded(pool, posting.canonicalUserId);

  const { matchCount } = await runMatchingForPosting(pool, posting.id, created || materiallyChanged);
  if (created && matchCount === 0) {
    await sendMonitoringAcknowledgment(posting.canonicalUserId);
  }

  return {
    postingId: posting.id,
    canonicalUserId: posting.canonicalUserId,
    created,
    materiallyChanged,
    matchCount,
  };
}
