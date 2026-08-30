import 'dotenv/config';
import { Pool } from 'pg';
import { createApp } from './app';
import { runMigrations } from './db/migrate';
import { runFsSync, runWtbSync } from './services/sync.service';
import { reconcileMatches } from './services/matching.service';
import { runMonitorLifecycleJob } from './services/monitor.service';
import { getWhatsAppAdapterIfConfigured } from './adapters/whatsapp.client';
import { getTelegramAdapterIfConfigured } from './adapters/telegram.client';
import { getSmsAdapterIfConfigured } from './adapters/sms.client';
import { getEmailAdapterIfConfigured } from './adapters/email.client';
import { MessagingAdapter, setMessagingAdapter } from './adapters/messaging.adapter';
import { MultiChannelAdapter } from './adapters/multiChannel.adapter';
import { Platform } from './types/domain';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const applied = await runMigrations(pool);
  if (applied.length) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] applied: ${applied.join(', ')}`);
  }

  // Each channel activates independently based on its own credentials; a
  // canonical user is reached on whichever configured channel they actually
  // have an identity on (see MultiChannelAdapter). Any channel left
  // unconfigured is simply absent, not an error -- same "report disabled,
  // don't fail" spirit as ENABLE_WTB_SYNC.
  const channelAdapters: Partial<Record<Platform, MessagingAdapter>> = {};

  const whatsappAdapter = getWhatsAppAdapterIfConfigured(pool);
  if (whatsappAdapter) {
    channelAdapters.whatsapp = whatsappAdapter;
    // eslint-disable-next-line no-console
    console.log('[messaging] WhatsApp Cloud API adapter active');
  } else {
    // eslint-disable-next-line no-console
    console.log('[messaging] WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID not set -- WhatsApp channel disabled');
  }

  const telegramAdapter = getTelegramAdapterIfConfigured(pool);
  if (telegramAdapter) {
    channelAdapters.telegram = telegramAdapter;
    // eslint-disable-next-line no-console
    console.log('[messaging] Telegram Bot API adapter active');
  } else {
    // eslint-disable-next-line no-console
    console.log('[messaging] TELEGRAM_BOT_TOKEN not set -- Telegram channel disabled');
  }

  const smsAdapter = getSmsAdapterIfConfigured(pool);
  if (smsAdapter) {
    channelAdapters.sms = smsAdapter;
    // eslint-disable-next-line no-console
    console.log('[messaging] Twilio SMS adapter active');
  } else {
    // eslint-disable-next-line no-console
    console.log('[messaging] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER not set -- SMS channel disabled');
  }

  const emailAdapter = getEmailAdapterIfConfigured(pool);
  if (emailAdapter) {
    channelAdapters.email = emailAdapter;
    // eslint-disable-next-line no-console
    console.log('[messaging] SendGrid email adapter active');
  } else {
    // eslint-disable-next-line no-console
    console.log('[messaging] SENDGRID_API_KEY/SENDGRID_FROM_EMAIL not set -- email channel disabled');
  }

  if (Object.keys(channelAdapters).length > 0) {
    setMessagingAdapter(new MultiChannelAdapter(pool, channelAdapters));
  } else {
    // eslint-disable-next-line no-console
    console.log('[messaging] no channel credentials configured -- using stub messaging adapter');
  }

  // Refresh on startup (spec section 13), independently for FS and WTB.
  await runFsSync(pool).catch((err) => console.error('[sync:FS] startup sync failed', err));
  await runWtbSync(pool).catch((err) => console.error('[sync:WTB] startup sync failed', err));

  const fsSyncIntervalMs = Number(process.env.FS_SYNC_INTERVAL_MS ?? '90000');
  setInterval(() => {
    runFsSync(pool).catch((err) => console.error('[sync:FS] periodic sync failed', err));
    runWtbSync(pool).catch((err) => console.error('[sync:WTB] periodic sync failed', err));
  }, fsSyncIntervalMs);

  // Periodic reconciliation recovers matches missed by the immediate event path
  // (spec section 4.3, acceptance test 16).
  setInterval(() => {
    reconcileMatches(pool).catch((err) => console.error('[reconcile] periodic run failed', err));
  }, Number(process.env.RECONCILIATION_INTERVAL_MS ?? '300000'));

  setInterval(() => {
    runMonitorLifecycleJob(pool).catch((err) => console.error('[monitor-lifecycle] periodic run failed', err));
  }, Number(process.env.MONITOR_LIFECYCLE_INTERVAL_MS ?? '3600000'));

  const app = createApp(pool);
  const port = Number(process.env.PORT ?? '3000');
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Fi backend listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
