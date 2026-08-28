import { Router } from 'express';
import { Pool } from 'pg';
import { approveMatch, passMatch, confirmCounterparty, getRevealedContact } from '../services/approval.service';

export function matchRoutes(pool: Pool): Router {
  const router = Router();

  router.post('/:matchId/approve', async (req, res) => {
    const { recipientCanonicalUserId } = req.body as { recipientCanonicalUserId?: string };
    if (!recipientCanonicalUserId) {
      res.status(400).json({ error: 'recipientCanonicalUserId is required' });
      return;
    }
    try {
      const outcome = await approveMatch(pool, req.params.matchId, recipientCanonicalUserId);
      if (outcome.status === 'locked') {
        res.status(402).json(outcome);
        return;
      }
      res.status(200).json(outcome);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/:matchId/pass', async (req, res) => {
    const { recipientCanonicalUserId } = req.body as { recipientCanonicalUserId?: string };
    if (!recipientCanonicalUserId) {
      res.status(400).json({ error: 'recipientCanonicalUserId is required' });
      return;
    }
    try {
      await passMatch(pool, req.params.matchId, recipientCanonicalUserId);
      res.status(200).json({ status: 'passed' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/:matchId/confirm-counterparty', async (req, res) => {
    const { counterpartyCanonicalUserId, confirmed } = req.body as {
      counterpartyCanonicalUserId?: string;
      confirmed?: boolean;
    };
    if (!counterpartyCanonicalUserId || typeof confirmed !== 'boolean') {
      res.status(400).json({ error: 'counterpartyCanonicalUserId and confirmed are required' });
      return;
    }
    try {
      await confirmCounterparty(pool, req.params.matchId, counterpartyCanonicalUserId, confirmed);
      res.status(200).json({ status: 'recorded' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/:matchId/contact', async (req, res) => {
    const recipientCanonicalUserId = req.query.recipientCanonicalUserId as string | undefined;
    if (!recipientCanonicalUserId) {
      res.status(400).json({ error: 'recipientCanonicalUserId query param is required' });
      return;
    }
    const contact = await getRevealedContact(pool, req.params.matchId, recipientCanonicalUserId);
    if (!contact) {
      res.status(403).json({ error: 'contact not yet authorized for disclosure' });
      return;
    }
    res.status(200).json({ contactMethods: contact });
  });

  return router;
}
