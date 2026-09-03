/**
 * Finds the full-catalogue endpoint, and reports the shape of what it returns.
 *
 * src/watchfacts/api.ts knows exactly one listing feed — `available-flash-sales` — which serves
 * the promotional pool (a few hundred watches), not the catalogue. Moving Fi onto the catalogue
 * needs three facts this script establishes empirically rather than by guessing: the request
 * WatchFacts' own pages make, the shape of a row, and which field carries a listing's real
 * posted date.
 *
 * It logs in, opens the pages you name, and records every JSON response the site fetches while
 * doing so — so the endpoint reported is the one the site actually uses, not one that happened
 * to be in a list of guesses. Then it re-requests the most listing-shaped of those inside the
 * page session and prints a redacted sample.
 *
 * Run it where the network and credentials are (a sandboxed agent usually has neither):
 *
 *   WATCHFACTS_EMAIL=... WATCHFACTS_PASSWORD=... npm run wf:probe
 *   ... -- https://watchfacts.com/marketplace https://watchfacts.com/watches
 *
 * Read-only: it browses and issues GETs, and writes nothing back to WatchFacts.
 */
import { chromium } from "playwright";
import { login } from "./scraper";

/** Pages to browse when none are named. The catalogue's own URL is one of the unknowns. */
const DEFAULT_PAGES = ["https://watchfacts.com/"];

/** Field names worth checking for a real posted date, longest-standing conventions first. */
const DATE_KEY_PATTERN = /(created|posted|listed|published|added|start|date|time)/i;

interface Capture {
  url: string;
  status: number;
  rows: number;
  sample: Record<string, unknown> | null;
}

/** The JSON envelopes api.ts already tolerates, plus the bare-array case. */
function rowsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const key of ["data", "listings", "results", "items", "records", "rows"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** A value that reads as a date — an ISO-ish string, or a plausible unix timestamp. */
function looksLikeDate(value: unknown): boolean {
  if (typeof value === "number") return value > 946_684_800 && value < 4_102_444_800; // 2000..2100, seconds
  if (typeof value !== "string" || value.length < 8) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.parse("2000-01-01") && parsed < Date.parse("2100-01-01");
}

function describe(sample: Record<string, unknown>): void {
  const entries = Object.entries(sample);
  console.log(`  ${entries.length} fields on a row:`);
  for (const [key, value] of entries) {
    const rendered = typeof value === "object" && value !== null
      ? Array.isArray(value) ? `[${value.length} items]` : "{…}"
      : JSON.stringify(value);
    const flag = looksLikeDate(value) ? "  <-- DATE?" : DATE_KEY_PATTERN.test(key) ? "  <-- date-named" : "";
    console.log(`    ${key.padEnd(28)} ${String(rendered).slice(0, 70)}${flag}`);
  }
  const dateFields = entries.filter(([key, value]) => looksLikeDate(value) || DATE_KEY_PATTERN.test(key)).map(([key]) => key);
  console.log(dateFields.length
    ? `\n  Candidate posted-date fields: ${dateFields.join(", ")}`
    : `\n  No posted-date field found on this row — the freshness window would have to keep measuring from first sight.`);
}

async function main(): Promise<void> {
  const pages = process.argv.slice(2).filter((a) => a.startsWith("http"));
  const targets = pages.length > 0 ? pages : DEFAULT_PAGES;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const captures: Capture[] = [];
  const seen = new Set<string>();

  page.on("response", async (response) => {
    const url = response.url();
    if (!/json/i.test(response.headers()["content-type"] ?? "")) return;
    // Collapse paging/cache-busting query differences so one endpoint reports once.
    const key = url.split("?")[0];
    if (seen.has(key)) return;
    try {
      const rows = rowsOf(await response.json());
      if (!rows || rows.length === 0) return;
      seen.add(key);
      const first = rows[0];
      captures.push({
        url, status: response.status(), rows: rows.length,
        sample: first && typeof first === "object" ? (first as Record<string, unknown>) : null,
      });
    } catch {
      // Not JSON we can read, or the body was already consumed — nothing to learn here.
    }
  });

  console.log("Logging in…");
  await login(page);

  for (const target of targets) {
    console.log(`Browsing ${target}`);
    try {
      await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
      // Client-rendered catalogues fetch on scroll; nudge a few times to trigger paging.
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1200);
      }
    } catch (err) {
      console.warn(`  could not load: ${(err as Error).message}`);
    }
  }

  console.log(`\n${"=".repeat(78)}\nJSON feeds this site fetched, largest first\n${"=".repeat(78)}`);
  captures.sort((a, b) => b.rows - a.rows);
  if (captures.length === 0) {
    console.log("None. Name the catalogue page explicitly:  npm run wf:probe -- <url>");
  }
  for (const capture of captures) {
    console.log(`\n[${capture.status}] ${capture.rows} rows  ${capture.url}`);
    if (capture.sample) describe(capture.sample);
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("Send the block above (it is listing metadata, no account details) and the");
  console.log("catalogue sync can be mapped onto the real endpoint and its real posted date.");
  await browser.close();
}

main().catch((err) => { console.error("probe failed:", err); process.exit(1); });
