import { chromium, Browser, Page } from "playwright";
import { config } from "../config";

export interface LatestListing {
  id: string;
  title: string;
  price: string;
}

export interface WatchFactsSession {
  getLatestListing(profileId: string): Promise<LatestListing | null>;
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

export async function openWatchFactsSession(): Promise<WatchFactsSession> {
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
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
    async close() {
      await browser.close();
    },
  };
}
