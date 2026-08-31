import express, { Router } from 'express';
import { Pool } from 'pg';
import { verifyTwilioSignature } from '../adapters/sms.client';
import { resolveCanonicalUserForPlatformIdentity } from '../services/canonicalUser.service';
import { handleInboundText, handleButtonAction } from '../services/inboundMessage.service';
import { findMostRecentPendingMatchForUser } from '../services/approval.service';

const APPROVE_REPLY = /^approve\b/i;
const PASS_REPLY = /^pass\b/i;

function webhookUrl(req: express.Request): string {
  // Behind a proxy/load balancer req.protocol/host can be wrong for signature
  // purposes; TWILIO_WEBHOOK_BASE_URL lets an operator pin the exact public
  // URL Twilio was configured with instead.
  const base = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}${req.originalUrl}`;
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

export function smsRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      // Fail closed: never process an inbound webhook body we can't verify.
      res.status(503).json({ error: 'TWILIO_AUTH_TOKEN is not configured' });
      return;
    }
    const signature = req.header('x-twilio-signature');
    if (!verifyTwilioSignature(webhookUrl(req), req.body, signature, authToken)) {
      res.sendStatus(401);
      return;
    }

    // Empty TwiML: acknowledge without an auto-reply -- Fi replies via the
    // separate messaging adapter, not via a synchronous TwiML response.
    res.status(200).type('text/xml').send('<Response></Response>');

    const from = req.body.From as string | undefined;
    const messageSid = req.body.MessageSid as string | undefined;
    const body = ((req.body.Body as string) ?? '').trim();
    if (!from || !messageSid) return;

    try {
      if (APPROVE_REPLY.test(body) || PASS_REPLY.test(body)) {
        const { canonicalUserId } = await resolveCanonicalUserForPlatformIdentity(pool, {
          platform: 'sms',
          platformUserId: from,
        });
        const matchId = await findMostRecentPendingMatchForUser(pool, canonicalUserId);
        if (!matchId) return;
        await handleButtonAction(pool, canonicalUserId, APPROVE_REPLY.test(body) ? 'approve' : 'pass', matchId);
        return;
      }

      await handleInboundText(pool, {
        platform: 'sms',
        chatId: from,
        messageId: messageSid,
        senderPlatformUserId: from,
        body,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[sms] failed to process message ${messageSid}: ${(err as Error).message}`);
    }
  });

  return router;
}
