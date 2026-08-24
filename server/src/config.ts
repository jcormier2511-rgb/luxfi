import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  // Green API (green-api.com) instance credentials — see README for setup.
  greenApi: {
    idInstance: process.env.GREEN_API_ID_INSTANCE ?? "",
    apiTokenInstance: process.env.GREEN_API_API_TOKEN_INSTANCE ?? "",
    baseUrl: process.env.GREEN_API_BASE_URL ?? "https://api.green-api.com",
  },

  // Shared secret Green API appends as ?token= or checked against a header,
  // used to reject spoofed webhook calls. Optional but recommended.
  webhookToken: process.env.WEBHOOK_TOKEN ?? "",

  matching: {
    creditsPerMatch: Number(process.env.CREDITS_PER_MATCH ?? 15),
    freeMatchesPerDealer: Number(process.env.FREE_MATCHES_PER_DEALER ?? 3),
  },

  // Allows POSTing synthetic WhatsApp events at /simulate/message for local
  // development without a live Green API instance. Never enable in production.
  devSimulateEndpoint: process.env.ENABLE_DEV_SIMULATE === "true",
};

export function assertGreenApiConfigured(): void {
  required("GREEN_API_ID_INSTANCE", config.greenApi.idInstance || undefined);
  required("GREEN_API_API_TOKEN_INSTANCE", config.greenApi.apiTokenInstance || undefined);
}
