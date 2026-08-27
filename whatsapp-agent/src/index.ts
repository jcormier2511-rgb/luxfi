import { config } from "./config";
import { createServer } from "./server";
import { runInventorySync } from "./watchfacts/syncInventory";
import { initSchema } from "./postings/db";
import { sendExpirationReminders } from "./postings/reminders";

const app = createServer();

app.listen(config.server.port, () => {
  console.log(`LuxFi WhatsApp agent listening on port ${config.server.port}`);
  console.log(`Webhook URL to configure in Whapi.Cloud: https://<your-host>/webhook?token=${config.server.webhookToken}`);
});

// Initialize/validate the additive v4 postings schema unconditionally — even while
// ENABLE_V4_POSTINGS is false — so the (additive, idempotent) migration is proven working in
// production well before the flag is ever flipped on. Never processes postings or sends a
// message; see src/postings/db.ts's initSchema.
initSchema()
  .then(() => console.log(`[postings] v4 schema ready${config.postingsV4.enabled ? "" : " (v4 disabled)"}`))
  .catch((err) => console.error("[postings] v4 schema initialization failed:", err.message));

// Expiration reminders only run when v4 itself is enabled — with it off, no chat postings
// ever get created (see groupMonitor.ts), so there would be nothing to remind about anyway.
if (config.postingsV4.enabled) {
  const reminderIntervalMs = Number(process.env.V4_REMINDER_INTERVAL_MINUTES ?? 60) * 60_000;
  const reminderTick = () => {
    sendExpirationReminders()
      .then((r) => {
        if (r.remindersSent > 0) console.log(`[postings] sent ${r.remindersSent} expiration reminder(s)`);
      })
      .catch((err) => console.error("[postings] expiration reminder run failed:", err.message));
  };
  reminderTick();
  setInterval(reminderTick, reminderIntervalMs);
}

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
