import "dotenv/config";
import path from "path";
import { MEMBERSHIP_PLANS, PlanKey } from "./billing/plans";

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
  admin: {
    sessionSecret: process.env.ADMIN_SESSION_SECRET ?? "",
    initial: { name: process.env.ADMIN_INITIAL_NAME ?? "", username: process.env.ADMIN_INITIAL_USERNAME ?? "", email: process.env.ADMIN_INITIAL_EMAIL ?? "", passwordHash: process.env.ADMIN_INITIAL_PASSWORD_HASH ?? "" },
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
  // Fi Conversation Flow Spec (v3) copy. Billing is tracked in Postgres only (canonical_users.
  // total_approved_count / account_entitlements — see postings/approvalUsage.ts and
  // billing/entitlementStore.ts) — no payment processor is wired in, so "join" records intent
  // for an admin to review rather than charging or unlocking anything itself.
  fiFlow: {
    introMessage:
      process.env.FI_INTRO_MESSAGE ??
      "Hi, I'm Fi — your personal luxury concierge.\nI'm here to help you:\n1. Find a buyer\n2. Find a seller\n3. Check pricing and market trends\n4. Check dealer reputation / references\n\nI'll automatically work on your first 3 matches so you can see what I can do.",
    // Flat-fee, weekly-capped tiers (billing/plans.ts) — no per-approval charge. Fired exactly
    // once, on the 3rd complimentary approval.
    conversionPitch: (firstName: string) =>
      `Hi ${firstName}, I hope you've enjoyed having me work for you.\nI can keep monitoring the market and working on your behalf automatically.\n\n` +
      `Fi Membership — flat ${MEMBERSHIP_PLANS.tier1.priceLabel}\n- ${MEMBERSHIP_PLANS.tier1.weeklyLimit} WTB/FS introductions per week, no per-match fees\n\n` +
      `Need more room? Upgrade anytime — ${MEMBERSHIP_PLANS.tier2.weeklyLimit}/week for ${MEMBERSHIP_PLANS.tier2.priceLabel}, or unlimited for ${MEMBERSHIP_PLANS.tier3.priceLabel}.\n\n` +
      `I'll continuously help you find buyers, find sellers, check pricing, and verify dealer reputation.\n\n` +
      `Reply "join" to keep Fi working for you.`,
    // Locked with no plan at all (never joined, or joined and was never assigned one).
    noPlanMessage:
      'No problem — I\'ll still flag matches for you, but approving one going forward means becoming a Fi member first.\nMessage me "join" anytime you\'re ready.',
    // Locked with an active plan, but this week's introductions are used up.
    weeklyCapMessage: (plan: PlanKey, weeklyLimit: number) => {
      const current = MEMBERSHIP_PLANS[plan];
      const upgrades = (Object.values(MEMBERSHIP_PLANS) as (typeof MEMBERSHIP_PLANS)[PlanKey][])
        .filter((p) => p.key !== plan && (p.weeklyLimit === null || p.weeklyLimit > weeklyLimit))
        .map((p) => (p.weeklyLimit === null ? `unlimited for ${p.priceLabel}` : `${p.weeklyLimit}/week for ${p.priceLabel}`))
        .join(", or ");
      return (
        `You've used all ${weeklyLimit} of your introductions this week on the ${current.label} plan (${current.priceLabel}).\n` +
        (upgrades ? `Reply "upgrade" to raise your limit — ${upgrades}.\n` : "") +
        `It resets on a rolling 7-day basis, or message "upgrade" anytime.`
      );
    },
    // Sent right after a real connection reveal (never on "pending_confirmation" — nothing's
    // been revealed yet, so there's no counterparty to inspect or escrow anything with). Same
    // text everywhere it's used (v3's on-demand approval, v4's approver-side reveal, and v4's
    // one-time push to the side that was left waiting) — kept name-free since v4 has no
    // reliable first name to personalize with, unlike conversionPitch/introMessage.
    escrowSuggestion:
      process.env.FI_ESCROW_SUGGESTION_MESSAGE ??
      "If you don't already know this contact, I also have escrow and inspection partners who can help verify the item and handle payment safely — just ask and I can connect you.",
    // Offered when either party replies "yes" to the escrow suggestion above (see
    // conversation/flow.ts's pendingEscrowOffer handling) — first service free, then a
    // recurring discount with membership. Not itself a live charge/discount system: redeeming
    // this code is on the escrow/inspection partner's own side, same as every other price in
    // this app that has no payment processor behind it yet.
    escrowPromoCode: process.env.FI_ESCROW_PROMO_CODE ?? "FI727",
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
  marketUpdates: {
    // Deliberately off until Railway is explicitly configured. The scheduler and schema are
    // harmless while disabled; no customer-facing message can be sent by default.
    enabled: (process.env.ENABLE_MARKET_UPDATES ?? "false").toLowerCase() === "true",
    morningTime: process.env.MARKET_UPDATE_MORNING_TIME ?? "09:00",
    afternoonTime: process.env.MARKET_UPDATE_AFTERNOON_TIME ?? "16:00",
    timezone: process.env.MARKET_UPDATE_TIMEZONE ?? "America/New_York",
    // Capped by duePeriod at 60 minutes so a bad Railway value can never send a digest hours late.
    graceMinutes: Number(process.env.MARKET_UPDATE_GRACE_MINUTES ?? 60),
    allowUnchanged: (process.env.MARKET_UPDATE_ALLOW_UNCHANGED ?? "false").toLowerCase() === "true",
    minimumObservations: Number(process.env.MARKET_UPDATE_MIN_OBSERVATIONS ?? 3),
  },
  // Hybrid AI-assisted matching (src/ai/) — layers NL query interpretation and AI reranking
  // on top of the existing deterministic engine; never replaces it. Off by default, and even
  // once enabled, only ever active for AI_MATCHING_TEST_PHONE — every other contact keeps
  // getting the plain deterministic matching/engine.ts path unchanged. Requires
  // ANTHROPIC_API_KEY; with it unset, the feature stays inert regardless of the flag rather
  // than guessing at credentials.
  aiMatching: {
    enabled: (process.env.ENABLE_AI_MATCHING ?? "false").toLowerCase() === "true",
    // Deliberately independent of `enabled` above, not a sub-flag of it — `enabled` only ever
    // affects ONE phone number's searches (see isAiMatchingEnabledForPhone), but ingestion-time
    // enrichment (watchfacts/aiEnrich.ts, conversation/groupMonitor.ts) applies to the WHOLE
    // inventory on every sync, not to any one person's request. Turning on AI for your own test
    // searches must never silently also start running AI calls against every listing in the
    // feed — that has to be its own explicit opt-in.
    enrichmentEnabled: (process.env.ENABLE_AI_INVENTORY_ENRICHMENT ?? "false").toLowerCase() === "true",
    // Hard cap on AI calls per sync run (see watchfacts/aiEnrich.ts) — kept conservative by
    // default since a real feed can be well over a million listings with thousands posted
    // daily; a row that exceeds this cap is simply retried on a later sync, not dropped.
    enrichmentMaxPerSync: Number(process.env.AI_ENRICHMENT_MAX_PER_SYNC ?? 25),
    // Comma-separated, same convention as WATCHFACTS_ADMIN_PHONES below — lets more than one
    // phone pilot AI matching without widening it to the whole population. Empty by default:
    // no phone is a test phone until explicitly configured, rather than defaulting to "on."
    testPhones: (process.env.AI_MATCHING_TEST_PHONE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Which backend src/ai/client.ts routes to — see src/ai/providers/{anthropic,openai}.ts.
    // Defaults to "anthropic" (the originally built/tested path) so an unset env var never
    // silently changes behavior for anyone already relying on it.
    provider: (process.env.AI_MATCHING_PROVIDER ?? "anthropic").toLowerCase() === "openai" ? "openai" : "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.AI_MATCHING_MODEL ?? "claude-sonnet-5",
    // No hardcoded default model id here — see providers/openai.ts's comment on why guessing
    // one would be worse than staying inert until it's set explicitly.
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.AI_MATCHING_OPENAI_MODEL ?? "",
  },
  // Fi Concierge expansion (src/concierge/) — group registry admin actions (enable/disable a
  // group, toggle reference requests) require the requesting phone to be on this list, in
  // addition to the existing WEBHOOK_TOKEN every other /admin/* route already requires. Empty
  // by default: no phone number is an admin until explicitly configured, rather than any
  // token-holder being able to act as one.
  concierge: {
    adminPhones: (process.env.WATCHFACTS_ADMIN_PHONES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  // Automatic currency conversion (src/fx/) — Open Exchange Rates for the MVP, deliberately
  // never the LLM: a wrong AI-estimated exchange rate could misrepresent whether a listing is
  // actually within a buyer's stated budget, exactly the kind of confidently-wrong-price bug
  // this whole matching pipeline has spent this session removing.
  fx: {
    provider: process.env.FX_PROVIDER ?? "openexchangerates",
    appId: process.env.OPEN_EXCHANGE_RATES_APP_ID ?? "",
    baseCurrency: (process.env.FX_BASE_CURRENCY ?? "USD").toUpperCase(),
    // How often the cached rates table is allowed to be refreshed — a fetch is only ever
    // made once this many minutes have passed since the last one, never per-listing/per-match.
    refreshMinutes: Number(process.env.FX_REFRESH_MINUTES ?? 60),
    // Past this age, a conversion is no longer trusted to confidently confirm a listing is
    // within budget — see fx/convert.ts.
    maxStalenessHours: Number(process.env.FX_MAX_STALENESS_HOURS ?? 24),
    defaultDisplayCurrency: (process.env.DEFAULT_DISPLAY_CURRENCY ?? "USD").toUpperCase(),
  },
};

/**
 * All three conditions required: the master flag, a real API key configured FOR WHICHEVER
 * PROVIDER is selected, and this exact phone number on the configured test-phone list — so
 * turning the flag on alone can never light this up for real users. No test phones configured
 * means the feature is inert for everyone, even with the flag on, rather than silently
 * defaulting to "enabled for all."
 */
export function isAiMatchingEnabledForPhone(phone: string): boolean {
  return isAiChatEnabled() && config.aiMatching.testPhones.includes(phone);
}

/**
 * General conversation is safe to enable for every contact once the operator has explicitly
 * enabled AI and configured provider credentials. Unlike matching/decisions, chat replies can
 * only supply text and cannot mutate search, approval, billing, or inventory state.
 */
export function isAiChatEnabled(): boolean {
  const hasProviderCredentials =
    config.aiMatching.provider === "openai"
      ? !!config.aiMatching.openaiApiKey && !!config.aiMatching.openaiModel
      : !!config.aiMatching.apiKey;
  return config.aiMatching.enabled && hasProviderCredentials;
}

/** Pure — the actual chat-id/allowlist matching logic, unit-testable without env/config wiring. */
export function isChatIdAllowed(chatId: string, allowedChatIds: string[]): boolean {
  return allowedChatIds.includes("*") || allowedChatIds.includes(chatId);
}

/** Both conditions required: the master flag AND this specific chat explicitly allowed. */
export function isV4ChatEnabled(chatId: string): boolean {
  return config.postingsV4.enabled && isChatIdAllowed(chatId, config.postingsV4.allowedChatIds);
}

/** True only for a phone explicitly configured as a WatchFacts administrator (WATCHFACTS_ADMIN_PHONES). */
export function isConciergeAdminPhone(phone: string): boolean {
  return config.concierge.adminPhones.includes(phone);
}

/**
 * The allowlist must keep applying to a posting for as long as it exists, not just at the
 * moment it was ingested — a group removed from V4_ALLOWED_CHAT_IDS (or the master flag
 * turned off) after a posting was already stored must stop it from generating notifications,
 * reminders, or approve/pass decisions immediately, without needing to touch or delete the
 * stored row. An API-mirrored WatchFacts listing was never chat-gated in the first place, so
 * it's always allowed here regardless of the chat allowlist.
 */
export function isPostingChatEnabled(posting: { source_type: string; source_chat_id: string | null }): boolean {
  if (posting.source_type !== "chat") return true;
  if (!posting.source_chat_id) return false;
  return isV4ChatEnabled(posting.source_chat_id);
}
