import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getAdminStatus } from '../services/admin.service';
import { setManualEntitlementOverride, setWatchFactsMembershipManual } from '../services/entitlement.service';
import { runFsSync, runWtbSync } from '../services/sync.service';
import { reconcileMatches } from '../services/matching.service';
import { mergeCanonicalUsers } from '../services/canonicalUser.service';

function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    // Fail closed: an unconfigured admin token means admin routes are unreachable,
    // not open. Never expose admin data/actions without an explicit token set.
    res.status(503).json({ error: 'ADMIN_API_TOKEN is not configured' });
    return;
  }
  if (req.header('x-admin-token') !== token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function adminRoutes(pool: Pool): Router {
  const router = Router();
  router.use(requireAdminToken);

  router.get('/status', async (_req, res) => {
    res.status(200).json(await getAdminStatus(pool));
  });

  /**
   * Manual entitlement override: unlocks (or re-locks) paid approvals for an
   * account without any payment processor wired up (testing / early users).
   * This is the only way approval #4+ becomes available in this MVP.
   */
  router.post('/users/:canonicalUserId/entitlement-override', async (req, res) => {
    const { enabled, reason, adminActor } = req.body as { enabled?: boolean; reason?: string; adminActor?: string };
    if (typeof enabled !== 'boolean' || !adminActor) {
      res.status(400).json({ error: 'enabled (boolean) and adminActor are required' });
      return;
    }
    const entitlement = await setManualEntitlementOverride(pool, req.params.canonicalUserId, enabled, adminActor, reason);
    res.status(200).json(entitlement);
  });

  /**
   * Manual WatchFacts membership verification stand-in -- automatic
   * verification via the WatchFacts membership API is deferred (spec 18.1).
   */
  router.post('/users/:canonicalUserId/watchfacts-verify', async (req, res) => {
    const { verified, adminActor } = req.body as { verified?: boolean; adminActor?: string };
    if (typeof verified !== 'boolean' || !adminActor) {
      res.status(400).json({ error: 'verified (boolean) and adminActor are required' });
      return;
    }
    const entitlement = await setWatchFactsMembershipManual(pool, req.params.canonicalUserId, verified, adminActor);
    res.status(200).json(entitlement);
  });

  /**
   * Links a provisional identity (an unknown chat participant Fi created
   * automatically) into a registered account -- e.g. once support confirms a
   * WhatsApp number belongs to an existing WatchFacts member (spec 5.2). Trial
   * usage and billing are recomputed from the merged history, never summed,
   * so this can never manufacture a second complimentary trial.
   */
  router.post('/users/:fromCanonicalUserId/merge-into/:toCanonicalUserId', async (req, res) => {
    const { fromCanonicalUserId, toCanonicalUserId } = req.params;
    if (fromCanonicalUserId === toCanonicalUserId) {
      res.status(400).json({ error: 'fromCanonicalUserId and toCanonicalUserId must differ' });
      return;
    }
    try {
      await mergeCanonicalUsers(pool, fromCanonicalUserId, toCanonicalUserId);
      res.status(200).json({ status: 'merged', from: fromCanonicalUserId, into: toCanonicalUserId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/sync/fs', async (_req, res) => {
    res.status(200).json(await runFsSync(pool));
  });

  router.post('/sync/wtb', async (_req, res) => {
    res.status(200).json(await runWtbSync(pool));
  });

  router.post('/reconcile', async (_req, res) => {
    res.status(200).json(await reconcileMatches(pool));
  });

  return router;
}
