import { Router } from 'express';
import { Pool } from 'pg';
import { ingestChatPosting } from '../services/posting.service';
import { runMatchingForPosting } from '../services/matching.service';
import { sendFirstContactIfNeeded, sendMonitoringAcknowledgment } from '../services/conversation.service';
import { ChatPostingInput } from '../types/domain';

export function webhookRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * Normalized chat-posting ingestion endpoint. A real WhatsApp/Telegram
   * webhook adapter (not available to build in this session -- no transport
   * credentials) would parse the provider's raw payload and call this same
   * shape; this is the stable seam it would plug into.
   */
  router.post('/chat-posting', async (req, res) => {
    const body = req.body as ChatPostingInput;
    if (!body || body.sourceType !== 'chat' || !body.platform || !body.chatId || !body.messageId || !body.postingType) {
      res.status(400).json({ error: 'missing required chat posting fields' });
      return;
    }

    try {
      const { posting, created, materiallyChanged } = await ingestChatPosting(pool, body);
      await sendFirstContactIfNeeded(pool, posting.canonicalUserId);

      const { matchCount } = await runMatchingForPosting(pool, posting.id, created || materiallyChanged);
      if (created && matchCount === 0) {
        await sendMonitoringAcknowledgment(posting.canonicalUserId);
      }

      res.status(created ? 201 : 200).json({ postingId: posting.id, created, materiallyChanged, matchCount });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
