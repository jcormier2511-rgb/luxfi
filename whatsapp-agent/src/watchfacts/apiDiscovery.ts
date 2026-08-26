import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { config } from "../config";

/**
 * Temporary investigation tool — NOT part of the production sync path. Attaches to a
 * Playwright page and records every response that looks like an API call (xhr/fetch,
 * JSON content-type, or an /api//_next/data//graphql-shaped URL) so we can find the real
 * endpoint WatchFacts' Trading Floor page uses, instead of scraping rendered DOM text.
 *
 * Deliberately never records header VALUES (only names) — this log is written to disk and
 * served back over an admin-token-gated endpoint, and a session cookie or bearer token is
 * exactly the kind of thing that must never end up sitting in a log file.
 */
export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  requestHeaderNames: string[];
  bodySample: string;
}

const API_URL_HINTS = /\/api\/|\/_next\/data\/|graphql|\/trpc\//i;

export function attachApiDiscovery(page: Page): CapturedResponse[] {
  const captured: CapturedResponse[] = [];

  page.on("response", async (response) => {
    try {
      const req = response.request();
      const resourceType = req.resourceType();
      const contentType = response.headers()["content-type"] ?? "";
      const looksLikeApi =
        resourceType === "xhr" ||
        resourceType === "fetch" ||
        contentType.includes("application/json") ||
        API_URL_HINTS.test(response.url());
      if (!looksLikeApi) return;

      let bodySample = "";
      try {
        bodySample = (await response.text()).slice(0, 4000);
      } catch {
        // No readable body (redirect, opaque response, etc.) — still record that the call happened.
      }

      captured.push({
        url: response.url(),
        method: req.method(),
        status: response.status(),
        contentType,
        requestHeaderNames: Object.keys(req.headers()),
        bodySample,
      });
    } catch (err) {
      console.error("[watchfacts] api-discovery capture failed for one response:", err);
    }
  });

  return captured;
}

export function saveApiDiscoveryLog(captured: CapturedResponse[]): void {
  const outPath = path.join(config.storageDir, "api-discovery.json");
  fs.mkdirSync(config.storageDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
}

export function readApiDiscoveryLog(): CapturedResponse[] | null {
  const outPath = path.join(config.storageDir, "api-discovery.json");
  if (!fs.existsSync(outPath)) return null;
  return JSON.parse(fs.readFileSync(outPath, "utf-8"));
}
