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
  greenApi: {
    idInstance: process.env.GREEN_API_ID_INSTANCE ?? "",
    tokenInstance: process.env.GREEN_API_TOKEN_INSTANCE ?? "",
    baseUrl: process.env.GREEN_API_BASE_URL ?? "https://api.green-api.com",
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
    delayMs: Number(process.env.OUTREACH_DELAY_MS ?? 8000),
  },
  data: {
    contactsCsv: path.resolve(process.env.CONTACTS_CSV ?? "./data/contacts.csv"),
    inventoryCsv: path.resolve(process.env.INVENTORY_CSV ?? "./data/wf_inventory.csv"),
  },
  trial: {
    maxItems: Number(process.env.TRIAL_MAX_ITEMS ?? 3),
    maxOptionsPerItem: Number(process.env.TRIAL_MAX_OPTIONS_PER_ITEM ?? 5),
  },
  storageDir: path.resolve("./storage"),
};
