import { Router } from 'express';
import { Pool } from 'pg';
import { verifyWhatsAppSignature } from '../adapters/whatsapp.client';
import { getMessagingAdapter } from '../adapters/messaging.adapter';
import { parseFreeTextPosting } from '../services/messageParsing.service';
import { ingestAndProcessChatPosting } from '../services/chatIngestion.service';
import { resolveCanonicalUserForPlatformIdentity } from '../services/canonicalUser.service';
import { approveMatch, passMatch, confirmCounterparty } from '../services/approval.service';
import { acknowledgeKeepWorking } from '../services/conversation.service';
import { extendPosting, findPostingsAwaitingExtensionForUser } from '../services/posting.service';

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

const JOIN_COMMAND = /^join$/i;
const EXTEND_COMMAND = /^extend$/i;

async function handleExtendCommand(pool: Pool, canonicalUserId: string): Promise<void> {
  const pending = await findPostingsAwaitingExtensionForUser(pool, canonicalUserId);
  if (pending.length === 0) {
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "I don't see a monitor waiting on an extension right now.",
    });
    return;
  }
  for (const posting of pending) {
    await extendPosting(pool, posting.id);
  }
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: `Extended! ${pending.length === 1 ? 'Your monitor' : `All ${pending.length} of your monitors`} will stay active for another 30 days.`,
  });
}

async function handleTextMessage(
  pool: Pool,
  chatId: string,
  message: WhatsAppMessage,
  senderDisplayName?: string
): Promise<void> {
  const body = (message.text?.body ?? '').trim();

  if (JOIN_COMMAND.test(body)) {
    const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
      platform: 'whatsapp',
      platformUserId: message.from,
      displayName: senderDisplayName,
    });
    await acknowledgeKeepWorking(canonicalUserId);
    return;
  }

  if (EXTEND_COMMAND.test(body)) {
    const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
      platform: 'whatsapp',
      platformUserId: message.from,
      displayName: senderDisplayName,
    });
    await handleExtendCommand(pool, canonicalUserId);
    return;
  }

  const parsed = parseFreeTextPosting(body);
  if (!parsed) return; // not recognizable as a command or an FS/WTB post -- leave it alone

  await ingestAndProcessChatPosting(pool, {
    sourceType: 'chat',
    platform: 'whatsapp',
    chatId,
    messageId: message.id,
    postingType: parsed.postingType,
    originalMessage: body,
    senderPlatformUserId: message.from,
    senderDisplayName,
    referenceNumber: parsed.referenceNumber,
    askingPrice: parsed.askingPrice,
    maxBid: parsed.maxBid,
    currency: parsed.currency,
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

  if (action === 'keep-working') {
    await acknowledgeKeepWorking(canonicalUserId);
    return;
  }

  if (!matchId) return;

  if (action === 'approve') {
    await approveMatch(pool, matchId, canonicalUserId);
  } else if (action === 'pass') {
    await passMatch(pool, matchId, canonicalUserId);
  } else if (action === 'confirm-share') {
    await confirmCounterparty(pool, matchId, canonicalUserId, true);
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: "Thanks -- I've shared your contact details.",
    });
  } else if (action === 'decline-share') {
    await confirmCounterparty(pool, matchId, canonicalUserId, false);
    await getMessagingAdapter().send({
      recipientCanonicalUserId: canonicalUserId,
      text: 'No problem -- your contact details were not shared.',
    });
  }
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
