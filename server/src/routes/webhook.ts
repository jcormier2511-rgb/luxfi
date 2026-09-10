import { Router } from "express";
import { normalizeGreenApiWebhook } from "../green-api/webhook.js";
import { handleIncomingMessage } from "../messageHandler.js";
import { config } from "../config.js";

export const webhookRouter = Router();

webhookRouter.post("/green-api", async (req, res) => {
  if (config.webhookToken && req.query.token !== config.webhookToken) {
    res.status(401).json({ error: "invalid webhook token" });
    return;
  }

  // Ack immediately — Green API retries on non-2xx/slow responses, and Fi's
  // work (DB writes, matching, outbound DMs) shouldn't block that ack.
  res.status(200).json({ ok: true });

  try {
    const normalized = normalizeGreenApiWebhook(req.body);
    if (normalized) {
      await handleIncomingMessage(normalized);
    }
  } catch (err) {
    console.error("Failed to process incoming webhook:", err);
  }
});
