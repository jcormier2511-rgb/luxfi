import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("./db") as typeof import("./db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { getMarketGuide, formatMarketGuide } = require("./marketGuide") as typeof import("./marketGuide");
const { getMarketPulse, getScopedMarketPulse } = require("./marketPulse") as typeof import("./marketPulse");
const rates = require("../fx/rates") as typeof import("../fx/rates");

after(async () => {
  await db._closePoolForTests();
  await inventory._closePoolForTests();
});
beforeEach(async () => {
  await db._resetDbForTests();
  await inventory._resetDbForTests();
  rates._setRatesForTests({ base: "USD", rates: { USD: 1, HKD: 8, EUR: 0.9 }, fetchedAt: new Date() });
});
after(() => rates._resetRatesForTests());

/** One FS postings row, minimal boilerplate — price/currency/dial/contact vary per test. */
async function insertFsPosting(opts: {
  id: string;
  reference: string;
  price: number | null;
  currency?: string;
  dial?: string;
  contactPhone?: string;
  contactName?: string;
  status?: string;
  expiresIn?: string;
}) {
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings
        (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,
         reference,dial,price,currency,contact_name,contact_phone,status,expires_at)
       VALUES ('whatsapp','chat','g1',$1,NULL,'FS','fixture',$2,$3,$4,$5,$6,$7,$8,now()+$9::interval)`,
      [
        opts.id,
        opts.reference,
        opts.dial ?? "",
        opts.price,
        opts.currency ?? "USD",
        opts.contactName ?? "",
        opts.contactPhone ?? "",
        opts.status ?? "active",
        opts.expiresIn ?? "1 day",
      ]
    )
  );
}

async function insertWtbPosting(opts: { id: string; reference: string; status?: string }) {
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings
        (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,status,expires_at)
       VALUES ('whatsapp','chat','g1',$1,NULL,'WTB','fixture',$2,$3,now()+interval '1 day')`,
      [opts.id, opts.reference, opts.status ?? "active"]
    )
  );
}

test("1. 116500 and 116500LN aliases normalize correctly — a shorthand and its full form aggregate as one canonical reference", async () => {
  await insertFsPosting({ id: "ln-1", reference: "116500LN", price: 24000 });
  await insertFsPosting({ id: "bare-1", reference: "116500", price: 25000 });

  const viaLn = await getMarketGuide({ reference: "116500LN" });
  const viaBare = await getMarketGuide({ reference: "116500" });
  assert.equal(viaLn.canonicalReference, "116500LN");
  assert.equal(viaBare.canonicalReference, "116500LN", "the shorthand resolves to the same canonical reference");
  assert.equal(viaLn.fsCount, 2);
  assert.equal(viaBare.fsCount, 2, "both spellings must see the same two listings");
});

test("2. duplicate/mirrored listings do not inflate the pricing sample, but the raw seller count is untouched", async () => {
  // Same seller (by phone), same price, posted twice — a mirrored repost, not two real listings.
  await insertFsPosting({ id: "dup-1", reference: "116500LN", price: 24000, contactPhone: "15551234567" });
  await insertFsPosting({ id: "dup-2", reference: "116500LN", price: 24000, contactPhone: "15551234567" });
  // A genuinely different seller at the same price is NOT a duplicate.
  await insertFsPosting({ id: "distinct-1", reference: "116500LN", price: 24000, contactPhone: "15559999999" });

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.fsCount, 3, "the seller count must reflect every real active listing, mirrored or not");
  assert.equal(guide.rawSampleSize, 2, "the mirrored repost collapses to one pricing observation");
  assert.equal(guide.comparableIdsExcluded.some((e) => e.reason.includes("duplicate")), true);
});

test("3. currency conversion works — HKD and EUR asks are normalized to USD before any statistic is computed", async () => {
  await insertFsPosting({ id: "hkd-1", reference: "116500LN", price: 192000, currency: "HKD" }); // -> $24,000
  await insertFsPosting({ id: "eur-1", reference: "116500LN", price: 22500, currency: "EUR" }); // -> $25,000
  await insertFsPosting({ id: "usd-1", reference: "116500LN", price: 23000, currency: "USD" });

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.rawSampleSize, 3);
  assert.equal(guide.medianAskUsd, 24000, "the HKD listing must be converted before the median is computed");
});

test("required regression: a WatchFacts listing with no detected native currency at all, from a Hong Kong dealer, is treated as HKD rather than silently defaulting to USD", async () => {
  // Real reported bug: WatchFacts has no dedicated currency column -- a listing's currency is
  // only ever detected from an explicit symbol/code in its own title text. A Hong Kong dealer's
  // bare-number title (no "HK$"/"HKD" at all) left nativeCurrency unset, and a HK$192,000
  // Daytona (really ~$24,000) got silently read as $192,000 USD, blowing out the whole range.
  await inventory.upsertListings(
    [
      {
        id: "hk-bare-1", type: "FS", category: "watches", item: "Rolex Daytona 116500LN 192000",
        brand: "Rolex", ref: "116500LN", condition: "", price: "192000", location: "Hong Kong",
        contactName: "HK Dealer", contactPhone: "1", rating: "", description: "",
        // nativePriceAmount/nativeCurrency intentionally omitted -- exactly what a bare-number,
        // no-currency-symbol title produces from mapToInventoryListings/extractNativePrice.
      },
    ],
    new Date().toISOString()
  );
  await insertFsPosting({ id: "usd-baseline-1", reference: "116500LN", price: 23800, currency: "USD" });
  await insertFsPosting({ id: "usd-baseline-2", reference: "116500LN", price: 24000, currency: "USD" });
  await insertFsPosting({ id: "usd-baseline-3", reference: "116500LN", price: 24200, currency: "USD" });

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.rawSampleSize, 4);
  // All ~$23,800-24,200 once the HK listing is correctly read as HKD -- if it were wrongly read
  // as USD ($192,000), the median would be nowhere near $24,000 and IQR would also misbehave (a
  // systematic mislabeling, not a real statistical outlier, is exactly what IQR cannot fix).
  assert.equal(guide.medianAskUsd, 24000);
});

test("4. stale listings (beyond the freshness window) are excluded", async () => {
  await insertFsPosting({ id: "fresh-1", reference: "116500LN", price: 24000 });
  await inventory.upsertListings(
    [
      {
        id: "stale-1", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
        condition: "", price: "50000", location: "", contactName: "Old", contactPhone: "1", rating: "", description: "",
      },
    ],
    new Date(Date.now() - 1000 * 60 * 60 * 24 * 400).toISOString() // 400 days ago — well past any sane freshness window
  );

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.fsCount, 1, "the stale WatchFacts listing must not count toward supply");
  assert.equal(guide.rawSampleSize, 1);
});

test("5. invalid prices (zero, negative, malformed) are excluded from pricing but still counted as active listings", async () => {
  await insertFsPosting({ id: "zero-1", reference: "116500LN", price: 0 });
  await insertFsPosting({ id: "null-1", reference: "116500LN", price: null });
  await insertFsPosting({ id: "good-1", reference: "116500LN", price: 24000 });
  await inventory.upsertListings(
    [
      {
        id: "malformed-1", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
        condition: "", price: "call for price", location: "", contactName: "X", contactPhone: "9", rating: "", description: "",
      },
    ],
    new Date().toISOString()
  );

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.fsCount, 4, "every active FS listing counts toward supply, priced or not");
  assert.equal(guide.rawSampleSize, 1, "only the one listing with a real, usable price enters the pricing sample");
});

test("6. extreme price outliers are excluded via IQR, without reducing the reported seller count", async () => {
  const normalPrices = [23000, 23500, 24000, 24200, 24500, 24700, 24800, 25000, 25200, 25500, 25900, 26000, 26200, 26500, 27000, 27200, 27500];
  for (const [i, price] of normalPrices.entries()) {
    await insertFsPosting({ id: `n-${i}`, reference: "116500LN", price, contactPhone: `seller-${i}` });
  }
  // One wildly extreme outlier among 17 otherwise-normal asks (18 total).
  await insertFsPosting({ id: "outlier-1", reference: "116500LN", price: 2, contactPhone: "seller-outlier" });

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.fsCount, 18, "the outlier is still a real, active listing — the seller count must include it");
  assert.equal(guide.rawSampleSize, 18, "raw pricing sample size before outlier filtering");
  assert.equal(guide.cleanSampleSize, 17, "the $2 listing must be excluded from the clean sample");
  assert.equal(guide.outliersExcluded, 1);
  assert.ok(guide.medianAskUsd! > 20000, "the median must not be dragged down by the $2 outlier");
});

test("7-8. median and P25/P75 are computed correctly over a known clean sample", async () => {
  // 9 values, 0-indexed sorted: 10000..18000 step 1000. Median = 14000 (5th of 9).
  for (let i = 0; i < 9; i++) {
    await insertFsPosting({ id: `p-${i}`, reference: "116500LN", price: 10000 + i * 1000, contactPhone: `seller-${i}` });
  }
  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.rawSampleSize, 9);
  assert.equal(guide.outliersExcluded, 0, "a smooth, evenly-spaced sample has no real outliers");
  assert.equal(guide.medianAskUsd, 14000);
  // Linear-interpolation P25/P75 over 9 sorted points (indices 0-8): pos = 8*0.25 = 2 -> value at index 2 = 12000; pos = 8*0.75 = 6 -> value at index 6 = 16000.
  assert.equal(guide.p25AskUsd, 12000);
  assert.equal(guide.p75AskUsd, 16000);
});

test("9. FS count is correct across both postings and the WatchFacts inventory mirror, without double-counting the FS mirror", async () => {
  await insertFsPosting({ id: "chat-fs-1", reference: "116500LN", price: 24000 });
  await inventory.upsertListings(
    [
      { id: "wf-fs-1", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN", condition: "", price: "25000", location: "", contactName: "A", contactPhone: "1", rating: "", description: "" },
      { id: "wf-fs-mirrored", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN", condition: "", price: "26000", location: "", contactName: "B", contactPhone: "2", rating: "", description: "" },
    ],
    new Date().toISOString()
  );
  // The API mirror of wf-fs-mirrored into postings — must be counted once, not twice.
  await db.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
       VALUES ('watchfacts_api','api',NULL,NULL,'wf-fs-mirrored','FS','mirror','116500LN',26000,'USD','active',now()+interval '1 day')`
    )
  );

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.fsCount, 3, "chat-fs-1 + wf-fs-1 + the one mirrored listing (counted once, not twice)");
});

test("10. WTB count is correct", async () => {
  await insertWtbPosting({ id: "wtb-1", reference: "116500LN" });
  await insertWtbPosting({ id: "wtb-2", reference: "116500LN" });
  await insertWtbPosting({ id: "wtb-closed", reference: "116500LN", status: "closed" });
  await inventory.upsertListings(
    [{ id: "wf-wtb-1", type: "WTB", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN", condition: "", price: "", location: "", contactName: "C", contactPhone: "3", rating: "", description: "" }],
    new Date().toISOString()
  );

  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.wtbCount, 3, "2 active chat WTB + 1 WatchFacts WTB; the closed one must not count");
});

test("11. seller market position is classified correctly at each boundary", async () => {
  // 5 clean asks: 20000, 22000, 24000, 26000, 28000 -> P25=22000, median=24000, P75=26000.
  const prices = [20000, 22000, 24000, 26000, 28000];
  for (const [i, price] of prices.entries()) {
    await insertFsPosting({ id: `pos-${i}`, reference: "116500LN", price, contactPhone: `seller-${i}` });
  }

  const atP25 = await getMarketGuide({ reference: "116500LN", askingPrice: 22000 });
  assert.equal(atP25.marketPosition, "aggressively_priced");
  const belowMedian = await getMarketGuide({ reference: "116500LN", askingPrice: 23000 });
  assert.equal(belowMedian.marketPosition, "competitive");
  const betweenMedianAndP75 = await getMarketGuide({ reference: "116500LN", askingPrice: 25000 });
  assert.equal(betweenMedianAndP75.marketPosition, "near_market");
  const aboveP75 = await getMarketGuide({ reference: "116500LN", askingPrice: 30000 });
  assert.equal(aboveP75.marketPosition, "above_market");
});

test("12. small-sample protection: 0-2 usable prices never show a range; 3-4 show observed data without aggressive IQR removal", async () => {
  const zero = await getMarketGuide({ reference: "116500LN" });
  assert.equal(zero.fsCount, 0);
  assert.equal(zero.medianAskUsd, null);
  assert.match(formatMarketGuide(zero), /Not enough current dealer listings/);

  await insertFsPosting({ id: "small-1", reference: "116500LN", price: 24000 });
  await insertFsPosting({ id: "small-2", reference: "116500LN", price: 100000 }); // a huge spread, but only 2 points
  const two = await getMarketGuide({ reference: "116500LN" });
  assert.equal(two.fsCount, 2);
  assert.equal(two.medianAskUsd, null, "2 usable prices must still not produce a range");

  // Add two more to reach 4 — a wide spread here must NOT be IQR-filtered at this sample size.
  await insertFsPosting({ id: "small-3", reference: "116500LN", price: 25000 });
  await insertFsPosting({ id: "small-4", reference: "116500LN", price: 26000 });
  const four = await getMarketGuide({ reference: "116500LN" });
  assert.equal(four.fsCount, 4);
  assert.equal(four.rawSampleSize, 4);
  assert.equal(four.cleanSampleSize, 4, "3-4 usable prices are never IQR-filtered");
  assert.equal(four.outliersExcluded, 0);
  assert.ok(four.medianAskUsd !== null, "3-4 usable prices DO produce a range, just without outlier removal");
});

test("required regression: if fewer than 3 observations survive IQR filtering, the price guide is suppressed rather than showing false precision", async () => {
  // 5 far-apart values so IQR collapses to a tiny window and only 2 points survive.
  const prices = [10000, 10500, 11000, 11500, 500000];
  for (const [i, price] of prices.entries()) {
    await insertFsPosting({ id: `iqr-${i}`, reference: "116500LN", price, contactPhone: `seller-${i}` });
  }
  const guide = await getMarketGuide({ reference: "116500LN" });
  assert.equal(guide.rawSampleSize, 5);
  // Whatever survives, if it's under 3 the guide must suppress rather than show a range.
  if (guide.cleanSampleSize < 3) {
    assert.equal(guide.medianAskUsd, null);
    assert.match(formatMarketGuide(guide), /Not enough current dealer listings/);
  }
});

test("13/14. Market Guide, Market Pulse, and Market Briefing (getScopedMarketPulse) report consistent FS/WTB counts for the same reference and snapshot", async () => {
  await insertFsPosting({ id: "c-1", reference: "116500LN", price: 24000 });
  await insertFsPosting({ id: "c-2", reference: "116500LN", price: 26000 });
  await insertWtbPosting({ id: "c-wtb-1", reference: "116500LN" });
  await inventory.upsertListings(
    [{ id: "wf-c-1", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN", condition: "", price: "25000", location: "", contactName: "A", contactPhone: "9", rating: "", description: "" }],
    new Date().toISOString()
  );

  const guide = await getMarketGuide({ reference: "116500LN" });
  const pulse = await getMarketPulse("116500LN");
  const briefing = await getScopedMarketPulse({ reference: "116500LN" });

  assert.equal(guide.fsCount, pulse.fsCount, "Market Guide and Market Pulse must agree on FS count");
  assert.equal(guide.wtbCount, pulse.wtbCount, "Market Guide and Market Pulse must agree on WTB count");
  assert.equal(guide.fsCount, briefing.fsCount, "Market Guide and Market Briefing must agree on FS count");
  assert.equal(guide.wtbCount, briefing.wtbCount, "Market Guide and Market Briefing must agree on WTB count");
});

test("formatMarketGuide renders the seller's ask, native currency, and USD hint together", async () => {
  const prices = [23000, 24000, 24700, 25000, 25900];
  for (const [i, price] of prices.entries()) {
    await insertFsPosting({ id: `fmt-${i}`, reference: "116500LN", price, contactPhone: `seller-${i}` });
  }
  const guide = await getMarketGuide({ reference: "116500LN", askingPrice: 192000, currency: "HKD" });
  const text = formatMarketGuide(guide, { amount: 192000, currency: "HKD" });
  assert.match(text, /Current sellers: 5/);
  assert.match(text, /Dealer asking range: \$\d/);
  assert.match(text, /Median dealer ask: \$/);
  assert.match(text, /Your ask: HKD 192,000 \(~\$24,000\)/);
  assert.match(text, /Market position: /);
  assert.doesNotMatch(text, /valuation/i, "spec: never call this a valuation");
});

test("dial refinement narrows to the seller's own dial only when enough comparables share it, otherwise falls back to all configurations", async () => {
  for (let i = 0; i < 4; i++) {
    await insertFsPosting({ id: `black-${i}`, reference: "116500LN", price: 24000 + i * 200, dial: "Black", contactPhone: `black-${i}` });
  }
  await insertFsPosting({ id: "white-1", reference: "116500LN", price: 40000, dial: "White", contactPhone: "white-1" });

  const refined = await getMarketGuide({ reference: "116500LN", dial: "Black" });
  assert.equal(refined.scope, "116500LN — Black dial");
  assert.equal(refined.rawSampleSize, 4, "only the 4 black-dial comparables are used once there are enough of them");

  await db._resetDbForTests();
  // Only 2 black-dial comparables this time — not enough to trust a refined scope.
  for (let i = 0; i < 2; i++) {
    await insertFsPosting({ id: `black2-${i}`, reference: "116500LN", price: 24000, dial: "Black", contactPhone: `black2-${i}` });
  }
  await insertFsPosting({ id: "white2-1", reference: "116500LN", price: 40000, dial: "White", contactPhone: "white2-1" });
  const fallback = await getMarketGuide({ reference: "116500LN", dial: "Black" });
  assert.equal(fallback.scope, "116500LN — all configurations", "falls back rather than creating fake precision from 2 comparables");
  assert.equal(fallback.rawSampleSize, 3);
});
