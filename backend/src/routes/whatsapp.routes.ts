import { Router } from 'express';
import { Pool } from 'pg';
import { verifyWhatsAppSignature } from '../adapters/whatsapp.client';
import { resolveCanonicalUserForPlatformIdentity } from '../services/canonicalUser.service';
import { handleInboundText, handleButtonAction } from '../services/inboundMessage.service';

interface WhatsAppMessage {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
}

interface WhatsAppWebhookBody {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id: string }[];
        messages?: WhatsAppMessage[];
      };
    }[];
  }[];
}

async function handleTextMessage(
  pool: Pool,
  chatId: string,
  message: WhatsAppMessage,
  senderDisplayName?: string
): Promise<void> {
  await handleInboundText(pool, {
    platform: 'whatsapp',
    chatId,
    messageId: message.id,
    senderPlatformUserId: message.from,
    senderDisplayName,
    body: message.text?.body ?? '',
  });
}

async function handleButtonReply(pool: Pool, message: WhatsAppMessage, senderDisplayName?: string): Promise<void> {
  const buttonId = message.interactive?.button_reply?.id;
  if (!buttonId) return;
  const [action, matchId] = buttonId.split(':');

  const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: message.from,
    displayName: senderDisplayName,
  });

  await handleButtonAction(pool, canonicalUserId, action, matchId);
}

export function whatsappRoutes(pool: Pool): Router {
  const router = Router();

  /** Meta's webhook verification handshake (one-time, when you register the webhook URL). */
  router.get('/', (req, res) => {
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (!verifyToken) {
      res.status(503).send('WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured');
      return;
    }
    if (mode === 'subscribe' && token === verifyToken) {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      // Fail closed: never process an inbound webhook body we can't verify.
      res.status(503).json({ error: 'WHATSAPP_APP_SECRET is not configured' });
      return;
    }
    const signature = req.header('x-hub-signature-256');
    if (!req.rawBody || !verifyWhatsAppSignature(req.rawBody, signature, appSecret)) {
      res.sendStatus(401);
      return;
    }

    // Always ack 200 once verified, even if a downstream message fails to
    // process -- Meta disables webhooks that repeatedly return errors, and one
    // bad message must not take down delivery for the rest of the batch.
    res.sendStatus(200);

    const body = req.body as WhatsAppWebhookBody;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;
        const senderName = value.contacts?.[0]?.profile?.name;
        const chatId = value.contacts?.[0]?.wa_id ?? value.messages[0]?.from ?? 'unknown';

        for (const message of value.messages) {
          try {
            if (message.type === 'text') {
              await handleTextMessage(pool, chatId, message, senderName);
            } else if (message.type === 'interactive') {
              await handleButtonReply(pool, message, senderName);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[whatsapp] failed to process message ${message.id}: ${(err as Error).message}`);
          }
        }
      }
    }
  });

  return router;
}
