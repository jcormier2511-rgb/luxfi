import { Router } from 'express';
import { Pool } from 'pg';
import { ingestAndProcessChatPosting } from '../services/chatIngestion.service';
import { ChatPostingInput } from '../types/domain';

export function webhookRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * Normalized chat-posting ingestion endpoint. Accepts an already-normalized
   * payload (platform, chatId, messageId, postingType, structured attributes).
   * The real WhatsApp webhook (whatsapp.routes.ts) parses the provider's raw
   * payload and free-text message body, then feeds the same underlying
   * pipeline; this endpoint remains useful directly for Telegram (later) or
   * any other source that can normalize on its own end.
   */
  router.post('/chat-posting', async (req, res) => {
    const body = req.body as ChatPostingInput;
    if (!body || body.sourceType !== 'chat' || !body.platform || !body.chatId || !body.messageId || !body.postingType) {
      res.status(400).json({ error: 'missing required chat posting fields' });
      return;
    }

    try {
      const result = await ingestAndProcessChatPosting(pool, body);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
