import { installProcessSafetyNets } from "./processSafety";
import { runCheckoutReconciliation } from "./billing/checkoutReconciliation";
import { isAuthorizeNetConfigured } from "./billing/authorizeNet";
import { config } from "./config";
import { createServer } from "./server";
import { runInventorySync } from "./watchfacts/syncInventory";
import { initSchema } from "./postings/db";
import { sendExpirationReminders } from "./postings/reminders";
import { runReconciliation } from "./postings/matching";
import { initConciergeSchema } from "./concierge/db";
import { runMarketUpdateScheduler } from "./marketUpdates";
import { runLifecycleScheduler } from "./lifecycle";


// Registered before anything else starts: a stray rejection on any background path used to take
// the whole bot down with no stack trace. See processSafety.ts.
installProcessSafetyNets();

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
  .then(() => {
    console.log(`[postings] v4 schema ready${config.postingsV4.enabled ? "" : " (v4 disabled)"}`);
    if (config.marketUpdates.enabled) runMarketUpdateScheduler();
    else console.log("[market-updates] disabled");
    const lifecycleTick=()=>runLifecycleScheduler().then(r=>{if(r.morning.sent||r.dormant.sent)console.log(`[lifecycle] sent ${r.morning.sent} briefing(s), ${r.dormant.sent} re-engagement(s)`)}).catch(err=>console.error("[lifecycle] run failed:",err.message));
    lifecycleTick();
    setInterval(lifecycleTick,Number(process.env.LIFECYCLE_INTERVAL_MINUTES??30)*60_000);
  })
  .catch((err) => console.error("[postings] v4 schema initialization failed:", err.message));

// Fi Concierge expansion, Stage 1 (group registry) — additive schema only, no behavior change
// yet. Nothing reads from designated_groups outside the new /admin/concierge/groups* routes
// until a later stage wires it into actual eligibility checks.
initConciergeSchema()
  .then(() => console.log("[concierge] schema ready (group registry only, not yet wired into eligibility)"))
  .catch((err) => console.error("[concierge] schema initialization failed:", err.message));

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

  // Fi Build Spec v4 §4.3: reconciliation must run periodically, not only on-demand via
  // POST /admin/reconciliation — it's the safety net that recovers a match missed because of a
  // webhook/API/process failure, which by definition can't be relied on to be triggered
  // manually. runReconciliation() itself is idempotent (an already-known, unchanged match is a
  // no-op — see matching.ts), so an overlapping/frequent tick is harmless, just wasted work.
  const reconciliationIntervalMs = Number(process.env.V4_RECONCILIATION_INTERVAL_MINUTES ?? 30) * 60_000;
  const reconciliationTick = () => {
    runReconciliation()
      .then((r) => {
        if (r.error) console.error(`[postings] scheduled reconciliation failed: ${r.error}`);
        else if (r.matchesCreatedOrChanged > 0) console.log(`[postings] reconciliation created/changed ${r.matchesCreatedOrChanged} match(es)`);
      })
      .catch((err) => console.error("[postings] scheduled reconciliation run threw:", err.message));
  };
  reconciliationTick();
  setInterval(reconciliationTick, reconciliationIntervalMs);
}

// A membership can only be activated by Authorize.net's paymentProfile.created webhook, so a
// webhook that is never delivered leaves a customer charged nothing, un-activated, and with
// nothing anywhere recording that it happened. Same safety-net reasoning as the v4 match
// reconciliation above: the failures worth sweeping for are precisely the ones that cannot
// report themselves. runCheckoutReconciliation only looks at checkouts old enough that a
// healthy webhook would already have arrived, and claims each one before charging, so a normal
// delivery always wins and an overlapping tick is a no-op rather than a second charge.
if (isAuthorizeNetConfigured()) {
  const checkoutReconciliationIntervalMs = Number(process.env.CHECKOUT_RECONCILIATION_INTERVAL_MINUTES ?? 15) * 60_000;
  const checkoutReconciliationTick = () => {
    runCheckoutReconciliation()
      .then((r) => {
        if (r.error) console.error(`[billing] checkout reconciliation failed: ${r.error}`);
        else if (r.activated > 0 || r.declined > 0)
          console.log(`[billing] checkout reconciliation activated ${r.activated}, declined ${r.declined} (scanned ${r.scanned})`);
      })
      .catch((err) => console.error("[billing] checkout reconciliation run threw:", err.message));
  };
  checkoutReconciliationTick();
  setInterval(checkoutReconciliationTick, checkoutReconciliationIntervalMs);
} else {
  console.log("[billing] Authorize.net not configured — checkout reconciliation sweep disabled.");
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
