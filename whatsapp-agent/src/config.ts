import "dotenv/config";
import path from "path";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

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
    membershipUrl: process.env.MEMBERSHIP_URL ?? "https://luxfi.ai/signup",
    demoUrl: process.env.DEMO_URL ?? "",
    // Sent as the header when a search kicks off for one item, per the provided copy —
    // phrased from the recipient's side of the trade (buying needs sellers, selling needs buyers).
    searchingMessageBuyer:
      process.env.SEARCHING_MESSAGE_BUYER ??
      "September Special: I'll match you with 3 verified sellers, free — checking what's out there now and flagging anything that hits the moment it's posted.",
    searchingMessageSeller:
      process.env.SEARCHING_MESSAGE_SELLER ??
      "September Special: I'll match you with 3 verified buyers, free — checking what's out there now and flagging anything that hits the moment it's posted.",
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
    contactsCsv: path.resolve(process.env.CONTACTS_CSV ?? "./data/contacts.csv"),
    inventoryCsv: path.resolve(process.env.INVENTORY_CSV ?? "./data/wf_inventory.csv"),
  },
  trial: {
    maxItems: Number(process.env.TRIAL_MAX_ITEMS ?? 3),
    maxOptionsPerItem: Number(process.env.TRIAL_MAX_OPTIONS_PER_ITEM ?? 5),
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
  },
  storageDir: path.resolve("./storage"),
};
