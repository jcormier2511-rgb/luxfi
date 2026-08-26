import { config } from "./config";
import { createServer } from "./server";
import { runInventorySync } from "./watchfacts/syncInventory";

const app = createServer();

app.listen(config.server.port, () => {
  console.log(`LuxFi WhatsApp agent listening on port ${config.server.port}`);
  console.log(`Webhook URL to configure in Whapi.Cloud: https://<your-host>/webhook?token=${config.server.webhookToken}`);
});

// Refresh the WatchFacts Trading Floor feed on boot, then on a fixed interval. Each run is a
// fresh login (no persistent browser session kept across ticks yet — see README) so
// INVENTORY_SYNC_INTERVAL_MINUTES defaults to 5, not 1-2, to keep repeated-login volume low
// (the same category of risk as the WhatsApp number bans hit earlier in this project).
// runInventorySync's own re-entrancy guard means an overlapping tick just skips, never queues.
if (config.watchfacts.email && config.watchfacts.password) {
  const intervalMs = Number(process.env.INVENTORY_SYNC_INTERVAL_MINUTES ?? 5) * 60_000;
  const tick = () => {
    runInventorySync()
      .then((r) => console.log(`[watchfacts] sync: ${r.total} active (${r.forSale} FS, ${r.wtb} WTB)`))
      .catch((err) => console.error("[watchfacts] scheduled sync failed:", err.message));
  };
  tick();
  setInterval(tick, intervalMs);
} else {
  console.log("[watchfacts] WATCHFACTS_EMAIL/PASSWORD not set — inventory sync scheduler disabled.");
}
