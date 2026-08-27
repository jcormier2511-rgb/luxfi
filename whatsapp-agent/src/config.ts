import "dotenv/config";
import path from "path";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

// Everything that needs to survive a restart/redeploy lives under one directory, so one
// Railway volume mounted at /app/persist covers it all — no need to hunt for a way to
// attach a second volume to the same service.
const persistDir = path.resolve(process.env.PERSIST_DIR ?? "./persist");

export const config = {
  whapi: {
    token: process.env.WHAPI_TOKEN ?? "",
    baseUrl: process.env.WHAPI_BASE_URL ?? "https://gate.whapi.cloud",
  },
  server: {
    port: Number(process.env.PORT ?? 3000),
    webhookToken: required("WEBHOOK_TOKEN", "change-me"),
  },
  outreach: {
    introMessage:
      process.env.INTRO_MESSAGE ??
      "Hi {{name}} — this is Fi from LuxFi. Tell me up to 3 items you're looking to buy or sell and I'll find you matches — free for your first 3 items.",
    bannerImageUrl: process.env.BANNER_IMAGE_URL ?? "",
    // MEMBERSHIP_URL is currently unused by the conversation flow — the Fi Conversation Flow
    // Spec (v3) keeps "hiring Fi" ($50/mo) and "WatchFacts membership" ($150/mo) deliberately
    // separate, so this WatchFacts signup link isn't mixed into the Fi hiring pitch. Kept
    // configured for whenever the cross-system membership check (spec §4/Open Items) exists.
    membershipUrl: process.env.MEMBERSHIP_URL ?? "https://watchfacts.com/login",
    // Cap how many never-contacted Tier A/B contacts a single blast run will message —
    // keeps a pilot run bounded regardless of how large the underlying CSV is.
    batchLimit: Number(process.env.OUTREACH_BATCH_LIMIT ?? 50),
    // Messages per hour, spread evenly (5/hr = one every 12 min). Takes precedence over
    // OUTREACH_DELAY_MS when set, since "N per hour" is the unit people actually reason in.
    ratePerHour: Number(process.env.OUTREACH_RATE_PER_HOUR ?? 5),
    get delayMs(): number {
      if (this.ratePerHour > 0) return Math.round(3600000 / this.ratePerHour);
      return Number(process.env.OUTREACH_DELAY_MS ?? 8000);
    },
  },
  data: {
    contactsCsv: path.resolve(process.env.CONTACTS_CSV ?? path.join(persistDir, "data/contacts.csv")),
    // Kept as a separate CSV on purpose: group-monitor captures accumulate by appending and
    // are merged with the DB at read time (getActiveListings), so a WatchFacts sync can never
    // wipe out anything a dealer group has posted.
    groupListingsCsv: path.resolve(process.env.GROUP_LISTINGS_CSV ?? path.join(persistDir, "data/group_listings.csv")),
  },
  // WatchFacts Trading Floor listings, synced via the real available-flash-sales API (see
  // src/watchfacts/api.ts + inventoryDb.ts) — a real Postgres database, not a file, so it
  // isn't tied to the app's own volume/container lifecycle. Attach a Railway Postgres plugin
  // to this service; Railway injects DATABASE_URL automatically once it's attached.
  database: {
    url: required("DATABASE_URL", process.env.NODE_ENV === "test" ? "postgres://postgres:postgres@127.0.0.1:5432/luxfi_test" : undefined),
  },
  // Self-hosted alternative to a third-party image host: POST /admin/upload/banner writes
  // here, and it's served back out at PUBLIC_BASE_URL + /assets/<file>.
  assets: {
    dir: path.resolve(process.env.ASSETS_DIR ?? path.join(persistDir, "assets")),
  },
  // Needed to build a usable BANNER_IMAGE_URL after uploading via /admin/upload/banner —
  // set this to the platform-assigned public domain (e.g. https://your-app.up.railway.app).
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  trial: {
    // Per the Fi Conversation Flow Spec (v3): trial = 3 *approved* matches, not 3 searches.
    // Searching and passing are unlimited; only "approve" is metered.
    maxApprovedMatches: Number(process.env.TRIAL_MAX_APPROVED_MATCHES ?? process.env.TRIAL_MAX_ITEMS ?? 3),
    maxOptionsPerItem: Number(process.env.TRIAL_MAX_OPTIONS_PER_ITEM ?? 5),
  },
  // Fi Conversation Flow Spec (v3) copy. Billing is tracked only (approvedCount / hired on
  // ConversationState) — no payment processor is wired in, so "join" just unlocks unlimited
  // approvals going forward rather than charging anything.
  fiFlow: {
    introMessage:
      process.env.FI_INTRO_MESSAGE ??
      "Hi, I'm Fi — your personal luxury concierge.\nI'm here to help you:\n1. Find a buyer\n2. Find a seller\n3. Check pricing and market trends\n4. Check dealer reputation / references\n\nI'll automatically work on your first 3 matches so you can see what I can do.",
    conversionPitch: (firstName: string) =>
      `Hi ${firstName}, I hope you've enjoyed having me work for you.\nI can keep monitoring the market and working on your behalf automatically.\n\n` +
      `Fi Membership — $50/month (free with WatchFacts membership)\n- $2 per approved match/task\n\n` +
      `I'll continuously help you find buyers, find sellers, check pricing, and verify dealer reputation.\n\n` +
      `Reply "join" to keep Fi working for you.`,
    declineMessage:
      'No problem — I\'ll still flag matches for you, but approving one going forward means becoming a Fi member first.\nMessage me "join" anytime you\'re ready.',
  },
  // Optional: personalizes each contact's intro with their own most recent WatchFacts
  // listing. Requires Playwright + a Chromium install in whatever environment actually
  // runs the blast — see src/watchfacts/README or the top-level README for setup.
  watchfacts: {
    enabled: (process.env.WATCHFACTS_ENABLED ?? "false").toLowerCase() === "true",
    loginUrl: process.env.WATCHFACTS_LOGIN_URL ?? "https://watchfacts.com/login",
    listingsUrlTemplate:
      process.env.WATCHFACTS_LISTINGS_URL_TEMPLATE ??
      "https://watchfacts.com/profile-listings?profileId={id}&profileAccessType=id",
    email: process.env.WATCHFACTS_EMAIL ?? "",
    password: process.env.WATCHFACTS_PASSWORD ?? "",
    // WTB's auction_type value isn't confirmed against the real API yet (the toggle button
    // that would reveal it isn't reliably clickable, and guessing candidate values is
    // explicitly out — see syncInventory.ts). Off by default: FS syncs and saves on its own,
    // WTB is reported as "disabled" rather than as a recurring error, until a real captured
    // value is available to hardcode.
    enableWtbSync: (process.env.ENABLE_WTB_SYNC ?? "false").toLowerCase() === "true",
  },
  storageDir: path.join(persistDir, "storage"),
  // Fi Build Spec v4 automatic monitoring/matching system (src/postings/) — reuses the same
  // Postgres database as everything else (config.database.url above; no competing database),
  // but its ingestion/notification path is gated behind this flag until its migrations,
  // integration tests, and notification behavior have been verified end-to-end. Off by
  // default: with this false, group-chat posts still feed the existing v3 CSV path
  // unchanged, and WatchFacts FS syncs still write inventory_listings unchanged — nothing
  // about the currently-deployed behavior depends on this flag being on.
  postingsV4: {
    enabled: (process.env.ENABLE_V4_POSTINGS ?? "false").toLowerCase() === "true",
    // Controlled test-group rollout: even with the master flag on, only these WhatsApp group
    // chat ids are actually monitored. Empty (the default) means no group is enabled yet —
    // ENABLE_V4_POSTINGS=true alone is not enough. "*" explicitly opts every group in, for a
    // later full rollout. Comma-separated, trimmed, case-sensitive (chat ids are opaque ids,
    // not display names).
    allowedChatIds: (process.env.V4_ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Spec: ask a poster before their monitor expires, not just document that extension
    // exists. Configurable so a later ops decision (e.g. 7 days) doesn't need a code change.
    reminderDaysBeforeExpiry: Number(process.env.V4_REMINDER_DAYS_BEFORE_EXPIRY ?? 3),
  },
};

/** Pure — the actual chat-id/allowlist matching logic, unit-testable without env/config wiring. */
export function isChatIdAllowed(chatId: string, allowedChatIds: string[]): boolean {
  return allowedChatIds.includes("*") || allowedChatIds.includes(chatId);
}

/** Both conditions required: the master flag AND this specific chat explicitly allowed. */
export function isV4ChatEnabled(chatId: string): boolean {
  return config.postingsV4.enabled && isChatIdAllowed(chatId, config.postingsV4.allowedChatIds);
}
