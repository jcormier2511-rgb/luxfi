import { Router } from 'express';
import { Pool } from 'pg';
import { verifyTelegramSecret, TelegramUpdate } from '../adapters/telegram.client';
import { resolveCanonicalUserForPlatformIdentity } from '../services/canonicalUser.service';
import { handleInboundText, handleButtonAction } from '../services/inboundMessage.service';

async function handleMessage(pool: Pool, message: NonNullable<TelegramUpdate['message']>): Promise<void> {
  const senderPlatformUserId = String(message.from?.id ?? message.chat.id);
  const senderDisplayName = message.from?.first_name ?? message.from?.username;
  await handleInboundText(pool, {
    platform: 'telegram',
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderPlatformUserId,
    senderDisplayName,
    body: message.text ?? '',
  });
}

async function handleCallback(pool: Pool, callback: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
  const data = callback.data;
  if (!data) return;
  const [action, arg] = data.split(':');

  const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'telegram',
    platformUserId: String(callback.from.id),
    displayName: callback.from.first_name ?? callback.from.username,
  });

  await handleButtonAction(pool, canonicalUserId, action, arg);
}

export function telegramRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) {
      // Fail closed: never process an inbound webhook body we can't verify.
      res.status(503).json({ error: 'TELEGRAM_WEBHOOK_SECRET is not configured' });
      return;
    }
    if (!verifyTelegramSecret(req.header('x-telegram-bot-api-secret-token'), secret)) {
      res.sendStatus(401);
      return;
    }

    // Always ack 200 once verified -- same "never let one bad update break
    // delivery of the rest" discipline as the WhatsApp webhook.
    res.sendStatus(200);

    const update = req.body as TelegramUpdate;
    try {
      if (update.message) {
        await handleMessage(pool, update.message);
      } else if (update.callback_query) {
        await handleCallback(pool, update.callback_query);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[telegram] failed to process update ${update.update_id}: ${(err as Error).message}`);
    }
  });

  return router;
}
