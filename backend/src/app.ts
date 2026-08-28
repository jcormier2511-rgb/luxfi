import express, { Express } from 'express';
import { Pool } from 'pg';
import { webhookRoutes } from './routes/webhook.routes';
import { matchRoutes } from './routes/match.routes';
import { adminRoutes } from './routes/admin.routes';

export function createApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/webhook', webhookRoutes(pool));
  app.use('/matches', matchRoutes(pool));
  app.use('/admin', adminRoutes(pool));

  return app;
}
