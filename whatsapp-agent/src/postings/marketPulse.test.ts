import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("./db") as typeof import("./db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { getMarketPulse, formatMarketPulse } = require("./marketPulse") as typeof import("./marketPulse");
const rates = require("../fx/rates") as typeof import("../fx/rates");
const urlValidator = require("../watchfacts/urlValidator") as typeof import("../watchfacts/urlValidator");

after(async () => { await db._closePoolForTests(); await inventory._closePoolForTests(); });
beforeEach(async () => { await db._resetDbForTests(); await inventory._resetDbForTests(); urlValidator._clearUrlValidationCacheForTests(); });

test("exact-reference pulse uses current normalized postings and deduplicates the WatchFacts mirror", async () => {
  await inventory.upsertListings([
    { id:"wf-duplicate", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"126500LN", condition:"new", price:"$28,000", location:"NY", contactName:"A", contactPhone:"1", rating:"", description:"" },
    { id:"wf-other", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"126500ln", condition:"new", price:"31,500", location:"NY", contactName:"B", contactPhone:"2", rating:"", description:"" },
    { id:"wf-wtb", type:"WTB", category:"watches", item:"Daytona", brand:"Rolex", ref:"126500LN", condition:"", price:"not a price", location:"", contactName:"C", contactPhone:"3", rating:"", description:"" },
    { id:"inactive", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"126500LN", condition:"", price:"99999", location:"", contactName:"D", contactPhone:"4", rating:"", description:"" },
    { id:"wrong-ref", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"116500LN", condition:"", price:"1", location:"", contactName:"E", contactPhone:"5", rating:"", description:"" },
  ], new Date().toISOString());

  await db.withSchema((pool) => pool.query(`
    UPDATE inventory_listings SET is_active=false WHERE external_id='inactive';
    INSERT INTO postings
      (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
    VALUES
      ('whatsapp','chat','approved-group','g-fs',NULL,'FS','normalized group FS','126500LN',30000,'USD','active',now()+interval '1 day'),
      ('whatsapp','chat','approved-group','g-wtb',NULL,'WTB','normalized group WTB','126500LN',NULL,'USD','active',now()+interval '1 day'),
      ('whatsapp','direct',NULL,NULL,NULL,'FS','valid active, missing price','126500LN',NULL,'USD','active',now()+interval '1 day'),
      ('whatsapp','chat','approved-group','expired',NULL,'FS','expired','126500LN',100000,'USD','active',now()-interval '1 second'),
      ('whatsapp','chat','approved-group','closed',NULL,'WTB','closed','126500LN',NULL,'USD','closed',now()+interval '1 day'),
      ('watchfacts_api','api',NULL,NULL,'wf-duplicate','FS','same underlying listing','126500LN',28000,'USD','active',now()+interval '1 day')
  `));

  const pulse = await getMarketPulse(" 126500ln ");
  assert.deepEqual({ ...pulse, averageFsAsk: Math.round(pulse.averageFsAsk! * 100) / 100 },
    { reference:"126500LN", requested:"126500LN", fsCount:4, wtbCount:2, averageFsAsk:29833.33,
      // The fourth FS posting has no price at all, so it counts toward fsCount but cannot
      // contribute to the average — and the basis says so rather than leaving it invisible.
      averageBasis:{ converted:3, skipped:1 },
      // None of these fixtures carries a detail_url, so there is nothing to link.
      listingUrls:[] });
  // Every pulse states the scope it counted, so a brand-wide number can't be mistaken for one
  // about a single reference.
  assert.equal(formatMarketPulse(pulse),
    "Market Pulse — 126500LN\n\nScope: this exact reference\nFS: 4 active listings\nWTB: 2 active requests\nImplied liquidity ratio: 1:2 (2 listings per buyer)\nAverage FS ask: $29,833\n(from 3 of 4 FS listings, converted to USD — 1 had no usable price or FX rate)\n\nBased on current WatchFacts flash-sale inventory and the dealer groups Fi monitors.");
});

test("pulse rejects a missing exact reference", async () => {
  await assert.rejects(getMarketPulse("   "), /exact watch reference/i);
});

/**
 * Live Market Briefing split 116500 and 116500LN into two buckets with different FS counts, WTB
 * counts and average asks for what is one watch: the aggregation exact-matched
 * upper(trim(reference)), so the shorthand a trader typed and the full reference a listing was
 * stored under never met. Both forms must now aggregate identically, in either query direction,
 * and the WatchFacts mirror must still be counted exactly once.
 */
test("116500 and 116500LN aggregate as one canonical bucket, in either direction", async () => {
  await inventory.upsertListings([
    { id:"wf-ln", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"116500LN", condition:"new", price:"$30,000", location:"NY", contactName:"A", contactPhone:"1", rating:"", description:"" },
    { id:"wf-bare", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"116500", condition:"new", price:"$34,000", location:"NY", contactName:"B", contactPhone:"2", rating:"", description:"" },
    { id:"wf-mirrored", type:"FS", category:"watches", item:"Daytona", brand:"Rolex", ref:"116500", condition:"new", price:"$50,000", location:"NY", contactName:"C", contactPhone:"3", rating:"", description:"" },
    { id:"wf-wtb-bare", type:"WTB", category:"watches", item:"Daytona", brand:"Rolex", ref:"116500", condition:"", price:"", location:"", contactName:"D", contactPhone:"4", rating:"", description:"" },
  ], new Date().toISOString());

  await db.withSchema((pool) => pool.query(`
    INSERT INTO postings
      (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
    VALUES
      ('whatsapp','chat','approved-group','g-ln',NULL,'FS','group FS, full reference','116500LN',32000,'USD','active',now()+interval '1 day'),
      ('whatsapp','chat','approved-group','g-bare',NULL,'FS','group FS, shorthand reference','116500',26000,'USD','active',now()+interval '1 day'),
      ('whatsapp','chat','approved-group','g-dashed',NULL,'WTB','group WTB, punctuated reference','116500-LN',NULL,'USD','active',now()+interval '1 day'),
      -- the same underlying WatchFacts listing, mirrored under the OTHER reference form: it must
      -- be counted once, not once per form.
      ('watchfacts_api','api',NULL,NULL,'wf-mirrored','FS','mirror of wf-mirrored','116500LN',50000,'USD','active',now()+interval '1 day'),
      ('whatsapp','chat','approved-group','g-other',NULL,'FS','a different watch entirely','116610LN',9000,'USD','active',now()+interval '1 day')
  `));

  // 3 inventory FS (wf-mirrored suppressed as a mirror) + 2 group FS + 1 mirrored FS posting = 5.
  const expected = { reference:"116500LN", fsCount:5, wtbCount:2, averageFsAsk:34400 };
  for (const typed of ["116500LN", "116500", " 116500ln ", "116500-LN"]) {
    const pulse = await getMarketPulse(typed);
    const { requested, averageBasis, listingUrls, ...rest } = pulse;
    assert.equal(requested, typed.trim().toUpperCase(), "the pulse reports what was actually asked for");
    assert.equal(averageBasis?.converted, 5, "every priced FS listing is in the average");
    assert.deepEqual(listingUrls, [], "these fixtures carry no detail_url");
    assert.deepEqual({ ...rest, averageFsAsk: Math.round(pulse.averageFsAsk!) }, expected,
      `"${typed}" must resolve to the same canonical bucket`);
  }

  // A reference with no alias entry keeps its own bucket — canonicalization is explicit, not a
  // blanket "append LN to Rolex references".
  const other = await getMarketPulse("116610LN");
  assert.equal(other.fsCount, 1);
  assert.equal(other.wtbCount, 0);
  const ambiguous = await getMarketPulse("116610");
  assert.equal(ambiguous.reference, "116610", "a bare 116610 is ambiguous (LN vs LV) and is never rewritten");
  assert.equal(ambiguous.fsCount, 0);
});

test("a pulse always states which scope it counted, and discloses a canonical reference swap", () => {
  // The same shape of numbers answers three different questions; without the scope line a
  // brand-wide count reads as though it were about the single reference that was asked for.
  const shorthand = formatMarketPulse({ reference:"116500LN", requested:"116500", label:"Rolex 116500LN", scope:"reference", fsCount:8, wtbCount:1, averageFsAsk:137286 });
  assert.match(shorthand, /Scope: this exact reference \(116500 and 116500LN are the same watch\)/);
  assert.match(shorthand, /WTB: 1 active request$/m, "a count of one is not pluralized");

  const exact = formatMarketPulse({ reference:"116500LN", requested:"116500LN", label:"116500LN", scope:"reference", fsCount:2, wtbCount:0, averageFsAsk:100 });
  assert.match(exact, /Scope: this exact reference$/m);
  assert.doesNotMatch(exact, /same watch/, "nothing to disclose when the typed reference is already canonical");

  const model = formatMarketPulse({ reference:"", label:"Rolex Daytona", scope:"model", fsCount:12, wtbCount:3, averageFsAsk:null });
  assert.match(model, /Scope: every reference under Rolex Daytona/);
  assert.match(model, /not shown across mixed references/);

  const brand = formatMarketPulse({ reference:"", label:"Rolex", scope:"brand", fsCount:180, wtbCount:1, averageFsAsk:null });
  assert.match(brand, /Scope: every Rolex listing Fi can see/);
  assert.match(brand, /not shown for a whole brand/);
});


/**
 * The averages used to be computed in SQL over USD rows only: a listing priced in HKD or EUR
 * counted toward the FS total but vanished from the average, so the headline figure silently
 * described a subset. Every currency is now converted to USD instead.
 */
test("non-USD listings are converted into the average, not dropped from it", async () => {
  rates._setRatesForTests({ base: "USD", rates: { USD: 1, HKD: 8, EUR: 0.5 }, fetchedAt: new Date() });
  try {
    await db.withSchema((pool) => pool.query(`
      INSERT INTO postings
        (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
      VALUES
        ('whatsapp','chat','g','fx-usd',NULL,'FS','usd','116500LN',30000,'USD','active',now()+interval '1 day'),
        ('whatsapp','chat','g','fx-hkd',NULL,'FS','hkd','116500LN',240000,'HKD','active',now()+interval '1 day'),
        ('whatsapp','chat','g','fx-eur',NULL,'FS','eur','116500LN',15000,'EUR','active',now()+interval '1 day')
    `));

    // HKD 240,000 / 8 = $30,000 and EUR 15,000 / 0.5 = $30,000 — all three are the same watch
    // at the same price, so the average must be exactly $30,000, not the USD row alone.
    const pulse = await getMarketPulse("116500LN");
    assert.equal(pulse.fsCount, 3);
    assert.equal(Math.round(pulse.averageFsAsk!), 30000);
    assert.deepEqual(pulse.averageBasis, { converted: 3, skipped: 0 });
    assert.doesNotMatch(formatMarketPulse(pulse), /had no usable price/, "nothing was skipped, so nothing is disclosed");
  } finally {
    rates._resetRatesForTests();
  }
});

test("a listing Fi cannot convert is reported as skipped rather than guessed at", async () => {
  rates._setRatesForTests({ base: "USD", rates: { USD: 1 }, fetchedAt: new Date() });
  try {
    await db.withSchema((pool) => pool.query(`
      INSERT INTO postings
        (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
      VALUES
        ('whatsapp','chat','g','sk-usd',NULL,'FS','usd','116500LN',30000,'USD','active',now()+interval '1 day'),
        ('whatsapp','chat','g','sk-jpy',NULL,'FS','jpy','116500LN',4000000,'JPY','active',now()+interval '1 day')
    `));

    // JPY has no rate in this table, so fx/convert.ts returns null rather than inventing one.
    const pulse = await getMarketPulse("116500LN");
    assert.equal(pulse.fsCount, 2, "it still counts as an active listing");
    assert.equal(Math.round(pulse.averageFsAsk!), 30000, "but never enters the average at a guessed rate");
    assert.deepEqual(pulse.averageBasis, { converted: 1, skipped: 1 });
    assert.match(formatMarketPulse(pulse), /from 1 of 2 FS listings, converted to USD — 1 had no usable price or FX rate/);
  } finally {
    rates._resetRatesForTests();
  }
});

test("a pulse never counts or averages inventory Fi would refuse to show as too old", async () => {
  const wf = (id: string, price: string) => ({
    id, type:"FS" as const, category:"watches", item:"Daytona", brand:"Rolex", ref:"116500LN",
    condition:"new", price, location:"NY", contactName:"A", contactPhone:"1", rating:"", description:"",
  });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  await inventory.upsertListings([wf("recent", "$30,000")], daysAgo(2));
  await inventory.upsertListings([wf("ancient", "$90,000")], daysAgo(40));

  const pulse = await getMarketPulse("116500LN");
  assert.equal(pulse.fsCount, 1, "the 40-day-old listing is out of the window and out of the count");
  assert.equal(pulse.averageFsAsk, 30000, "and it cannot drag the average with a price nobody can still buy at");
});

test("a pulse links the WatchFacts listings behind its numbers, and shows no link it could not reach", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    ({ ok: !String(url).includes("gone"), status: String(url).includes("gone") ? 404 : 200 }) as Response);
  const wf = (id: string, price: string) => ({
    id, type:"FS" as const, category:"watches", item:"Daytona", brand:"Rolex", ref:"116500LN",
    condition:"new", price, location:"NY", contactName:"A", contactPhone:"1", rating:"", description:"",
    detailUrl:`https://watchfacts.com/flash-sales/${id}`,
  });
  await inventory.upsertListings([wf("live-a","$30,000"), wf("gone","$31,000"), wf("live-b","$32,000")], new Date().toISOString());

  const pulse = await getMarketPulse("116500LN");
  assert.deepEqual(pulse.listingUrls, [
    "https://watchfacts.com/flash-sales/live-a",
    "https://watchfacts.com/flash-sales/live-b",
  ], "the 404 link is dropped rather than sent broken");
  assert.match(formatMarketPulse(pulse), /Current WatchFacts listings:\nhttps:\/\/watchfacts\.com\/flash-sales\/live-a\nhttps:\/\/watchfacts\.com\/flash-sales\/live-b/);
});

test("a pulse with no reachable WatchFacts link shows no empty link heading", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }) as Response);
  await db.withSchema((pool) => pool.query(`
    INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
    VALUES ('whatsapp','chat','approved-group','g-fs',NULL,'FS','group FS','116500LN',30000,'USD','active',now()+interval '1 day')`));

  const pulse = await getMarketPulse("116500LN");
  assert.deepEqual(pulse.listingUrls, []);
  assert.doesNotMatch(formatMarketPulse(pulse), /Current WatchFacts listing/);
});
