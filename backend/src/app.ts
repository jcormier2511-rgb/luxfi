import express, { Express } from 'express';
import { Pool } from 'pg';
import { webhookRoutes } from './routes/webhook.routes';
import { whatsappRoutes } from './routes/whatsapp.routes';
import { matchRoutes } from './routes/match.routes';
import { adminRoutes } from './routes/admin.routes';

export function createApp(pool: Pool): Express {
  const app = express();
  // Capture the raw body bytes alongside the parsed JSON: WhatsApp's webhook
  // signature is computed over the exact bytes Meta sent, which a re-serialized
  // JSON object would not reliably reproduce.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf;
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/webhook', webhookRoutes(pool));
  app.use('/webhook/whatsapp', whatsappRoutes(pool));
  app.use('/matches', matchRoutes(pool));
  app.use('/admin', adminRoutes(pool));

  return app;
}
