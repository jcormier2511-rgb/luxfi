import express from "express";
import { config } from "./config.js";
import { webhookRouter } from "./routes/webhook.js";
import { simulateRouter } from "./routes/simulate.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/webhook", webhookRouter);

if (config.devSimulateEndpoint) {
  console.log("[fi-bot] ENABLE_DEV_SIMULATE=true — /simulate/message is mounted, dev use only");
  app.use("/simulate", simulateRouter);
}

app.listen(config.port, () => {
  console.log(`[fi-bot] listening on :${config.port}`);
});
