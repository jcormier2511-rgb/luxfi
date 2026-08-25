import express from "express";
import { config } from "./config";
import { extractIncomingText, IncomingWebhook, sendText } from "./greenapi/client";
import { alreadyProcessed } from "./conversation/stateStore";
import { handleIncomingMessage } from "./conversation/flow";
import { getTierABContacts } from "./data/contactsStore";
import { runOutreachBlast } from "./outreach/blast";

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // GreenAPI webhook receiver. Configure this URL (with ?token=WEBHOOK_TOKEN) as the
  // instance's webhookUrl in the GreenAPI console, with incomingMessageReceived enabled.
  app.post("/webhook", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    // Ack immediately — GreenAPI retries on slow/failed responses.
    res.status(200).json({ ok: true });

    const body = req.body as IncomingWebhook;
    if (alreadyProcessed(body.idMessage)) return;

    const incoming = extractIncomingText(body);
    if (!incoming) return;

    const contact = getTierABContacts().find((c) => c.phone === incoming.phone);
    try {
      const { messages } = handleIncomingMessage(incoming.phone, incoming.text, contact);
      for (const message of messages) {
        await sendText(incoming.phone, message);
      }
    } catch (err) {
      console.error(`[webhook] failed handling message from ${incoming.phone}:`, err);
    }
  });

  // Manual trigger to kick off the Tier A/B blast over HTTP instead of the CLI script.
  // Protect this behind the same webhook token since it sends real messages.
  app.post("/outreach/start", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    try {
      const summary = await runOutreachBlast();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app;
}
