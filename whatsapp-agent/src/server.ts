import express from "express";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { extractIncomingMessages, IncomingWebhook, sendText } from "./whapi/client";
import { alreadyProcessed } from "./conversation/stateStore";
import { handleIncomingMessage } from "./conversation/flow";
import { getTierABContacts, loadContacts } from "./data/contactsStore";
import { loadInventory } from "./data/inventoryStore";
import { planOutreachBatch, executeOutreachBatch } from "./outreach/blast";
import { readBlastStatus } from "./outreach/status";

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Whapi.Cloud webhook receiver. Configure this URL as the channel's webhook (Settings →
  // Webhooks) with the "messages" event enabled.
  app.post("/webhook", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    // Ack immediately — Whapi retries on slow/failed responses.
    res.status(200).json({ ok: true });

    const body = req.body as IncomingWebhook;
    const incoming = extractIncomingMessages(body).filter((m) => !alreadyProcessed(m.id));

    for (const message of incoming) {
      const contact = getTierABContacts().find((c) => c.phone === message.phone);
      try {
        const { messages } = handleIncomingMessage(message.phone, message.text, contact);
        for (const reply of messages) {
          await sendText(message.phone, reply);
        }
      } catch (err) {
        console.error(`[webhook] failed handling message from ${message.phone}:`, err);
      }
    }
  });

  // Manual trigger to kick off the Tier A/B blast over HTTP instead of the CLI script.
  // At OUTREACH_RATE_PER_HOUR pacing a batch can take hours, so this only plans the
  // batch synchronously and returns immediately — the actual sends happen in the
  // background and progress is polled via GET /outreach/status.
  // Protect this behind the same webhook token since it sends real messages.
  app.post("/outreach/start", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (readBlastStatus().state === "running") {
      return res.status(409).json({ error: "a blast is already running — check /outreach/status" });
    }
    const plan = planOutreachBatch();
    res.json({
      started: true,
      batchSize: plan.batch.length,
      alreadyContacted: plan.alreadyContacted,
      remainingAfterBatch: plan.remainingAfterBatch,
      etaHours: config.outreach.ratePerHour > 0 ? +(plan.batch.length / config.outreach.ratePerHour).toFixed(1) : null,
    });
    executeOutreachBatch(plan).catch((err) => {
      console.error("[outreach] batch failed:", err);
    });
  });

  app.get("/outreach/status", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json(readBlastStatus());
  });

  // Real contacts.csv / wf_inventory.csv are git-ignored on purpose, so a fresh deploy's
  // persistent volume starts empty. These let you push the real files onto a running
  // deployment (e.g. `curl --data-binary @contacts.csv "https://<host>/admin/upload/contacts?token=..."`)
  // without needing shell/SSH access to the container.
  const csvUpload = express.text({ type: "*/*", limit: "20mb" });

  app.post("/admin/upload/contacts", csvUpload, (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    fs.mkdirSync(path.dirname(config.data.contactsCsv), { recursive: true });
    fs.writeFileSync(config.data.contactsCsv, req.body);
    const contacts = loadContacts(true);
    res.json({ ok: true, bytes: req.body.length, contacts: contacts.length });
  });

  app.post("/admin/upload/inventory", csvUpload, (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    fs.mkdirSync(path.dirname(config.data.inventoryCsv), { recursive: true });
    fs.writeFileSync(config.data.inventoryCsv, req.body);
    const listings = loadInventory(true);
    res.json({ ok: true, bytes: req.body.length, listings: listings.length });
  });

  return app;
}
