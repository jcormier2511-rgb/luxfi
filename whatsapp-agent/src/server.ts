import express from "express";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { extractIncomingMessages, IncomingWebhook, sendText } from "./whapi/client";
import { alreadyProcessed, getState, resetState } from "./conversation/stateStore";
import { handleIncomingMessage } from "./conversation/flow";
import { handleGroupMessage } from "./conversation/groupMonitor";
import { getTierABContacts, loadContacts } from "./data/contactsStore";
import { getActiveListings, getSyncStatus } from "./watchfacts/inventoryDb";
import { planOutreachBatch, executeOutreachBatch } from "./outreach/blast";
import { readBlastStatus } from "./outreach/status";
import { runInventorySync } from "./watchfacts/syncInventory";

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
        const { messages } = await handleIncomingMessage(message.phone, message.text, contact);
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

  // Real contacts.csv is git-ignored on purpose, so a fresh deploy's persistent volume starts
  // empty. This lets you push the real file onto a running deployment (e.g.
  // `curl --data-binary @contacts.csv "https://<host>/admin/upload/contacts?token=..."`)
  // without needing shell/SSH access to the container. WatchFacts inventory has no equivalent
  // upload path — it's populated only by syncing from the real API (see /admin/sync-inventory).
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
  app.get("/admin/debug-info", async (req, res) => {
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
    const listings = await getActiveListings();
    res.json({
      cwd: process.cwd(),
      env: { PERSIST_DIR: process.env.PERSIST_DIR ?? null, CONTACTS_CSV: process.env.CONTACTS_CSV ?? null, DATABASE_URL: process.env.DATABASE_URL ? "set" : null },
      persistDir: describe(persistDir),
      contactsCsv: describe(config.data.contactsCsv),
      groupListingsCsv: describe(config.data.groupListingsCsv),
      persistDirListing: fs.existsSync(persistDir) ? fs.readdirSync(persistDir) : null,
      persistDataListing: fs.existsSync(path.join(persistDir, "data")) ? fs.readdirSync(path.join(persistDir, "data")) : null,
      activeListingCount: listings.length,
      activeListingSample: listings.slice(0, 3).map((l) => ({ id: l.id, type: l.type, contactName: l.contactName, item: l.item, source: l.source })),
    });
  });

  // Sync health at a glance — when it last succeeded, current FS/WTB/total active counts,
  // and the last error if the most recent attempt failed (data from the previous success
  // is kept either way; see runInventorySync's "0 results" guard).
  app.get("/admin/inventory-status", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json(await getSyncStatus());
  });

  app.use("/assets", express.static(config.assets.dir));

  // Logs into WatchFacts and re-syncs the Trading Floor feed (both FS and WTB) via the real
  // available-flash-sales API into the SQLite-backed inventory store — see
  // src/watchfacts/{api,syncInventory,inventoryDb}.ts. Requires WATCHFACTS_EMAIL/PASSWORD.
  // Takes ~10-30s (login + paginated fetches), so this awaits the result rather than
  // backgrounding it like /outreach/start. The scheduler in index.ts calls this on its own
  // interval; this endpoint is for a manual/on-demand re-sync.
  app.post("/admin/sync-inventory", async (req, res) => {
    if (req.query.token !== config.server.webhookToken) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!config.watchfacts.email || !config.watchfacts.password) {
      return res.status(400).json({ error: "WATCHFACTS_EMAIL / WATCHFACTS_PASSWORD not set" });
    }
    try {
      const result = await runInventorySync();
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "a sync is already running" ? 409 : 500).json({ error: message });
    }
  });

  return app;
}
