import fs from "fs";
import path from "path";
import { chromium, Browser, Page } from "playwright";
import { config } from "../config";
import { InventoryListing, ListingType } from "../types";
import { attachApiDiscovery, saveApiDiscoveryLog } from "./apiDiscovery";

export interface LatestListing {
  id: string;
  title: string;
  price: string;
}

export interface WatchFactsSession {
  getLatestListing(profileId: string): Promise<LatestListing | null>;
  /**
   * Scrapes the WatchFacts Trading Floor (watchfacts.com/buy/all) for either side of the
   * market and returns rows already shaped for wf_inventory.csv / the matching engine.
   * Only reads the first page of results currently — no pagination/"load more" handling yet.
   */
  fetchTradingListings(type: ListingType): Promise<InventoryListing[]>;
  close(): Promise<void>;
}

/**
 * NOTE ON RELIABILITY: this environment can't reach watchfacts.com (network egress
 * blocked), so these selectors were inferred from screenshots, not verified against the
 * live DOM. Run `npm run wf:test -- <profileId>` in an environment that CAN reach the site
 * to validate/tune this before trusting it in a real outreach blast.
 */

async function login(page: Page): Promise<void> {
  if (!config.watchfacts.email || !config.watchfacts.password) {
    throw new Error("WATCHFACTS_EMAIL / WATCHFACTS_PASSWORD not set");
  }
  await page.goto(config.watchfacts.loginUrl, { waitUntil: "domcontentloaded" });

  const email = page.locator('input[type="email"], input[name*="email" i], input[id*="email" i]').first();
  const password = page.locator('input[type="password"]').first();
  await email.fill(config.watchfacts.email);
  await password.fill(config.watchfacts.password);

  const submit = page.getByRole("button", { name: /log\s?in|sign\s?in/i }).first();
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), submit.click()]);
}

export interface AuctionTypeProbeResult {
  auctionType: string;
  status: number;
  ok: boolean;
  bodySample: string;
}

const AUCTION_TYPE_CANDIDATES = [
  "wtb",
  "buy",
  "want_to_buy",
  "want-to-buy",
  "ntq",
  "purchase",
  "request",
  "looking_to_buy",
  "ltb",
  "buying",
];

/**
 * Temporary investigation tool — NOT part of the production sync path. The UI's NTQ/WTB
 * toggle button isn't reliably clickable via Playwright (times out — likely not a real
 * <button>/<a> element), so instead of fighting that selector, this logs in once and tries
 * the real `available-flash-sales` API directly (discovered via apiDiscovery.ts) with a set
 * of likely `auction_type` values, from inside the authenticated page context so the
 * session cookie is included automatically. Whichever value returns real listings (not an
 * error or empty array) is the one syncInventory.ts should use for WTB.
 */
export async function probeAuctionTypes(): Promise<AuctionTypeProbeResult[]> {
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await login(page);
    await page.goto("https://watchfacts.com/buy/all?listing_type=sale", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    return await page.evaluate(async (candidates: string[]) => {
      const out: { auctionType: string; status: number; ok: boolean; bodySample: string }[] = [];
      for (const c of candidates) {
        try {
          const url = `https://watchfacts.com/available-flash-sales?pageSize=5&page=1&auction_type=${encodeURIComponent(c)}&category_id=19&sort_by=date-newest`;
          const res = await fetch(url, { credentials: "include" });
          const text = await res.text();
          out.push({ auctionType: c, status: res.status, ok: res.ok, bodySample: text.slice(0, 800) });
        } catch (err) {
          out.push({ auctionType: c, status: 0, ok: false, bodySample: String(err) });
        }
      }
      return out;
    }, AUCTION_TYPE_CANDIDATES);
  } finally {
    await browser.close();
  }
}

/**
 * Walks up from the "#<id>" badge text (first one in DOM order, assumed most-recent-first
 * sort — unverified) to the nearest ancestor that also contains a "$..." price line, then
 * reads out the remaining line as the title. Deliberately structure-based rather than tied
 * to specific class names, since none are known.
 */
async function extractLatestListing(page: Page): Promise<LatestListing | null> {
  return page.evaluate(() => {
    const idPattern = /^#\d+$/;
    const pricePattern = /^\$[\d,.]+$/;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let idBadge: Element | null = null;
    while (walker.nextNode()) {
      const el = walker.currentNode as Element;
      if (el.children.length === 0 && idPattern.test(el.textContent?.trim() ?? "")) {
        idBadge = el;
        break;
      }
    }
    if (!idBadge) return null;

    let card: Element | null = idBadge;
    for (let i = 0; i < 6 && card; i++, card = card.parentElement) {
      const lines = (card.textContent ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const priceLine = lines.find((l) => pricePattern.test(l));
      if (!priceLine) continue;
      const idLine = lines.find((l) => idPattern.test(l)) ?? "";
      const titleLine = lines.find((l) => l !== priceLine && l !== idLine) ?? "";
      if (titleLine) return { id: idLine.replace("#", ""), title: titleLine, price: priceLine };
    }
    return null;
  });
}

interface RawTradingListing {
  id: string;
  title: string;
  price: string;
  rating: string;
  sellerName: string;
  contactPhone: string;
  detailUrl: string;
}

/**
 * From each "Check Availability" button (the one stable, text-identifiable anchor per card),
 * walks up to the enclosing card and pulls out title/price/rating/seller by line-matching the
 * card's text, plus the seller's WhatsApp number from the wa.me link's href and the listing id
 * from the /flash-sales/<id> detail link's href. Confirmed against a real WatchFacts screenshot
 * (Aug 2026) but not run against the live DOM — this sandbox can't reach watchfacts.com.
 * Validate with `npm run wf:test-inventory -- sale` before trusting it for a real sync.
 */
async function extractTradingListings(page: Page): Promise<RawTradingListing[]> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("a,button")).filter((el) =>
      /check availability/i.test(el.textContent ?? "")
    );

    const results: RawTradingListing[] = [];
    for (const trigger of cards) {
      let card: Element | null = trigger;
      for (let i = 0; i < 8 && card; i++) {
        const text = card.textContent ?? "";
        if (/\$[\d,.]+/.test(text) && /posted/i.test(text)) break;
        card = card.parentElement;
      }
      if (!card) continue;

      const lines = (card.textContent ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const priceLine = lines.find((l) => /^\$[\d,.]+$/.test(l)) ?? "";
      const postedLine = lines.find((l) => /^posted/i.test(l)) ?? "";
      const ratingLine = lines.find((l) => /rating/i.test(l)) ?? "";
      const titleLine = lines.find((l) => l.length > 5 && l !== priceLine && l !== postedLine && l !== ratingLine) ?? "";

      const waAnchor = card.querySelector('a[href*="wa.me/"]') as HTMLAnchorElement | null;
      const phoneMatch = waAnchor?.href.match(/wa\.me\/(\d+)/);
      const detailAnchor = card.querySelector('a[href*="/flash-sales/"]') as HTMLAnchorElement | null;
      const idMatch = detailAnchor?.href.match(/flash-sales\/(\d+)/);
      const sellerAnchor = Array.from(card.querySelectorAll("a")).find(
        (a) => a !== detailAnchor && a !== waAnchor && (a.textContent ?? "").trim().length > 1
      );

      if (!titleLine || !phoneMatch) continue; // no phone means no usable "reveal" contact — skip
      results.push({
        id: idMatch?.[1] ?? "",
        title: titleLine,
        price: priceLine.replace(/^\$/, ""),
        rating: /no rating/i.test(ratingLine) ? "" : ratingLine,
        sellerName: sellerAnchor?.textContent?.trim() ?? "",
        contactPhone: phoneMatch[1],
        detailUrl: detailAnchor?.href ?? "",
      });
    }
    return results;
  });
}

/**
 * On a /flash-sales/<id> detail page, reads the full listing text out of the
 * "Post Information" block — richer than the (sometimes truncated, "...See More") card
 * title on the list page. Same unverified-against-live-DOM caveat as the rest of this file.
 */
async function extractDetailDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const marker = Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && /post information/i.test(el.textContent ?? "")
    );
    let container: Element | null = marker ?? null;
    for (let i = 0; i < 4 && container; i++) {
      const text = container.textContent ?? "";
      if (/#\d+/.test(text) && /rating/i.test(text)) break;
      container = container.parentElement;
    }
    if (!container) return "";

    const lines = (container.textContent ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const descLine = lines.find(
      (l) =>
        l.length > 10 &&
        !/post information/i.test(l) &&
        !/rating/i.test(l) &&
        !/^#\d+/.test(l) &&
        !/^posted/i.test(l) &&
        !/^box:/i.test(l) &&
        !/^papers:/i.test(l)
    );
    return descLine ?? "";
  });
}

async function fetchTradingListings(page: Page, type: ListingType): Promise<InventoryListing[]> {
  await page.goto("https://watchfacts.com/buy/all?listing_type=sale", { waitUntil: "domcontentloaded" });
  if (type === "WTB") {
    try {
      await page.getByRole("button", { name: /ntq\s*\/\s*wtb/i }).click({ timeout: 5000 });
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    } catch (err) {
      console.error("[watchfacts] couldn't click the NTQ/WTB toggle — staying on the FS view:", err);
    }
  }
  await page.waitForTimeout(2500); // let client-rendered cards populate

  const raw = await extractTradingListings(page);

  // Debug aid: since this scraper was built from screenshots rather than a live test,
  // always save what the page actually looked like — lets us diagnose a 0-result run
  // (still on the login page? cards not rendered? different markup?) via /assets/ on the
  // deployed instance, without needing a local Playwright setup.
  try {
    fs.mkdirSync(config.assets.dir, { recursive: true });
    const debugPath = path.join(config.assets.dir, `debug-trading-${type.toLowerCase()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`[watchfacts] (${type}) found ${raw.length} listings — url: ${page.url()} — screenshot: ${debugPath}`);
  } catch (err) {
    console.error("[watchfacts] failed to save debug screenshot:", err);
  }

  // Visit each listing's own detail page for the full (non-truncated) description —
  // the list-page title is sometimes cut short with "...See More". Adds ~1-2s per listing.
  const descriptions: string[] = [];
  for (const r of raw) {
    if (!r.detailUrl) {
      descriptions.push("");
      continue;
    }
    try {
      await page.goto(r.detailUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      descriptions.push(await extractDetailDescription(page));
    } catch (err) {
      console.error(`[watchfacts] failed to fetch description for ${r.detailUrl}:`, err);
      descriptions.push("");
    }
  }

  return raw.map((r, i) => ({
    id: r.id || r.contactPhone,
    type,
    category: "watches",
    item: r.title,
    brand: "",
    ref: "",
    condition: "",
    price: r.price || "ASK",
    location: "",
    contactName: r.sellerName,
    contactPhone: r.contactPhone,
    source: "WF",
    rating: r.rating,
    description: descriptions[i] || r.title,
  }));
}

export async function openWatchFactsSession(): Promise<WatchFactsSession> {
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  // Temporary investigation aid (see src/watchfacts/apiDiscovery.ts) — captures every
  // XHR/fetch/JSON response across login + Trading Floor navigation so the real API
  // endpoint (if one exists) can be found instead of scraping rendered DOM text.
  const discoveryLog = attachApiDiscovery(page);
  await login(page);

  return {
    async getLatestListing(profileId: string) {
      const url = config.watchfacts.listingsUrlTemplate.replace("{id}", encodeURIComponent(profileId));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500); // let client-rendered listing cards populate
      try {
        return await extractLatestListing(page);
      } catch (err) {
        console.error(`[watchfacts] failed to extract listing for profile ${profileId}:`, err);
        return null;
      }
    },
    async fetchTradingListings(type: ListingType) {
      try {
        return await fetchTradingListings(page, type);
      } catch (err) {
        console.error(`[watchfacts] failed to fetch trading listings (${type}):`, err);
        return [];
      }
    },
    async close() {
      saveApiDiscoveryLog(discoveryLog);
      await browser.close();
    },
  };
}
