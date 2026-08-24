import { Router } from "express";
import { handleIncomingMessage } from "../messageHandler.js";

export const simulateRouter = Router();

/**
 * Dev-only endpoint for exercising the full pipeline without a live Green
 * API instance. Mounted only when ENABLE_DEV_SIMULATE=true. Example:
 *
 *   curl -X POST localhost:3000/simulate/message -H 'content-type: application/json' -d '{
 *     "chatId": "120363000000000000@g.us",
 *     "senderId": "15551230000@c.us",
 *     "senderName": "Marco D.",
 *     "chatName": "Watch Dealers NYC",
 *     "text": "FS Rolex Daytona 116500LN $18,500 CH",
 *     "isGroup": true
 *   }'
 */
simulateRouter.post("/message", async (req, res) => {
  const { chatId, senderId, senderName, chatName, text, isGroup } = req.body ?? {};

  if (typeof chatId !== "string" || typeof senderId !== "string" || typeof text !== "string") {
    res.status(400).json({ error: "chatId, senderId, and text are required strings" });
    return;
  }

  await handleIncomingMessage({
    whatsappMsgId: `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    chatId,
    senderId,
    senderName: senderName ?? null,
    chatName: chatName ?? null,
    text,
    isGroup: Boolean(isGroup),
    timestamp: new Date(),
  });

  res.status(200).json({ ok: true });
});
