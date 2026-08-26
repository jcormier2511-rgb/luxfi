import express from "express";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { extractIncomingMessages, IncomingWebhook, sendText } from "./whapi/client";
import { alreadyProcessed, getState, resetState } from "./conversation/stateStore";
import { handleIncomingMessage } from "./conversation/flow";
import { handleGroupMessage } from "./conversation/groupMonitor";
import { getTierABContacts, loadContacts } from "./data/contactsStore";
import { loadInventory } from "./data/inventoryStore";
import { planOutreachBatch, executeOutreachBatch } from "./outreach/blast";
import { readBlastStatus } from "./outreach/status";
import { runInventorySync } from "./watchfacts/syncInventory";
import { readApiDiscoveryLog } from "./watchfacts/apiDiscovery";
import { probeAuctionTypes } from "./watchfacts/scraper";

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
      try {
        if (message.isGroup) {
          // Silent by design — never reply into a group, only ingest WTB/FS-looking posts.
          handleGroupMessage(message.groupId!, message.phone, message.senderName, message.text);
          continue;
        }
        const contact = getTierABContacts().find((c) => c.phone === message.phone);
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

  // Read-only view of what group monitoring has captured so far — since it accumulates
  // silently (no reply into the group), this is the only way to confirm it's working
  // without SSH/shell access to the container.
  app.get("/admin/group-listings", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!fs.existsSync(config.data.groupListingsCsv)) {
      return res.json({ ok: true, count: 0, csv: "" });
    }
    const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
    const count = csv.trim().split("\n").length - 1; // minus header
    res.json({ ok: true, count, csv });
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

  // Testing helpers — conversation state persists on the volume across redeploys, so a
  // number that already passed "new" won't see the intro/trial-start behavior again
  // without this. `phone` is digits-only, no leading +, matching webhook payloads.
  app.get("/admin/conversation-state", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    res.json(getState(phone));
  });

  app.post("/admin/reset-state", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    resetState(phone);
    res.json({ ok: true, phone, reset: true });
  });

  // One-shot diagnostic to root-cause "why is it showing sample data" without guessing —
  // shows the actual resolved paths, what's on disk at each, and a peek at loaded inventory
  // so we can tell real WatchFacts data from the bundled sample from the response alone.
  app.get("/admin/debug-info", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    const describe = (p: string) => {
      if (!fs.existsSync(p)) return { path: p, exists: false };
      const stat = fs.statSync(p);
      return {
        path: p,
        exists: true,
        isDirectory: stat.isDirectory(),
        size: stat.isFile() ? stat.size : undefined,
        mtime: stat.mtime,
      };
    };
    const persistDir = path.resolve(process.env.PERSIST_DIR ?? "./persist");
    const listings = loadInventory(true);
    res.json({
      cwd: process.cwd(),
      env: { PERSIST_DIR: process.env.PERSIST_DIR ?? null, CONTACTS_CSV: process.env.CONTACTS_CSV ?? null, INVENTORY_CSV: process.env.INVENTORY_CSV ?? null },
      persistDir: describe(persistDir),
      contactsCsv: describe(config.data.contactsCsv),
      inventoryCsv: describe(config.data.inventoryCsv),
      groupListingsCsv: describe(config.data.groupListingsCsv),
      persistDirListing: fs.existsSync(persistDir) ? fs.readdirSync(persistDir) : null,
      persistDataListing: fs.existsSync(path.join(persistDir, "data")) ? fs.readdirSync(path.join(persistDir, "data")) : null,
      loadedInventoryCount: listings.length,
      loadedInventorySample: listings.slice(0, 3).map((l) => ({ id: l.id, contactName: l.contactName, item: l.item, source: l.source })),
    });
  });

  // Temporary investigation endpoint (see src/watchfacts/apiDiscovery.ts) — returns whatever
  // XHR/fetch/JSON traffic the last /admin/sync-inventory run observed, so we can find
  // WatchFacts' real data API instead of scraping rendered DOM text. Header VALUES are never
  // captured (only names), so this is safe to gate behind the same admin token as everything
  // else rather than needing extra protection.
  app.get("/admin/api-discovery", (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    const log = readApiDiscoveryLog();
    if (!log) return res.status(404).json({ error: "no capture yet — run POST /admin/sync-inventory first" });
    res.json({ ok: true, count: log.length, responses: log });
  });

  // Temporary investigation endpoint (see probeAuctionTypes in scraper.ts) — logs in once
  // and tries several likely `auction_type` values directly against WatchFacts' real API,
  // sidestepping the unreliable NTQ/WTB toggle button. Takes ~10-20s (one login + up to 10
  // fetches), so it awaits synchronously like /admin/sync-inventory does.
  app.post("/admin/probe-auction-types", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    try {
      const results = await probeAuctionTypes();
      res.json({ ok: true, results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.use("/assets", express.static(config.assets.dir));

  // Logs into WatchFacts and re-scrapes the Trading Floor feed (both FS and WTB) into
  // wf_inventory.csv, replacing whatever's there. Requires WATCHFACTS_EMAIL/PASSWORD.
  // Takes ~10-30s (login + two page loads), so this awaits the result rather than
  // backgrounding it like /outreach/start — call it from an external cron for a refresh
  // schedule, e.g. `curl -X POST ".../admin/sync-inventory?token=..."` every hour.
  let inventorySyncRunning = false;
  app.post("/admin/sync-inventory", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!config.watchfacts.email || !config.watchfacts.password) {
      return res.status(400).json({ error: "WATCHFACTS_EMAIL / WATCHFACTS_PASSWORD not set" });
    }
    if (inventorySyncRunning) {
      return res.status(409).json({ error: "a sync is already running" });
    }
    inventorySyncRunning = true;
    const debugBase = config.publicBaseUrl || "";
    const debugScreenshots = {
      sale: `${debugBase}/assets/debug-trading-fs.png`,
      wtb: `${debugBase}/assets/debug-trading-wtb.png`,
    };
    try {
      const result = await runInventorySync();
      loadInventory(true);
      res.json({ ok: true, ...result, debugScreenshots });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, debugScreenshots });
    } finally {
      inventorySyncRunning = false;
    }
  });

  return app;
}
