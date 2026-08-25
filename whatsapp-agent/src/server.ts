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

  // Self-hosts the banner image when there's no third-party URL to point BANNER_IMAGE_URL at:
  // `curl --data-binary @banner.jpg "https://<host>/admin/upload/banner?token=..."` writes it
  // to the persisted assets dir, served back out at /assets/<file>. Whapi's /messages/image
  // endpoint fetches media from a URL server-side, so this host must be public — that's why
  // PUBLIC_BASE_URL has to be set for the response's suggested `url` field to be usable.
  app.post("/admin/upload/banner", express.raw({ type: "*/*", limit: "15mb" }), (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    const ext = typeof req.query.ext === "string" ? req.query.ext.replace(/[^a-z0-9]/gi, "") || "jpg" : "jpg";
    const filename = `banner.${ext}`;
    fs.mkdirSync(config.assets.dir, { recursive: true });
    fs.writeFileSync(path.join(config.assets.dir, filename), req.body);
    const url = config.publicBaseUrl ? `${config.publicBaseUrl}/assets/${filename}` : `/assets/${filename}`;
    res.json({
      ok: true,
      bytes: req.body.length,
      url,
      note: config.publicBaseUrl
        ? `Set BANNER_IMAGE_URL to this url.`
        : "PUBLIC_BASE_URL isn't set — set it to this deployment's public domain, then use <that domain>/assets/" + filename + " as BANNER_IMAGE_URL.",
    });
  });

  app.use("/assets", express.static(config.assets.dir));

  return app;
}
