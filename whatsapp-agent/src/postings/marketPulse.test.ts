import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("./db") as typeof import("./db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { getMarketPulse, formatMarketPulse, formatNetworkMarketSnapshot } = require("./marketPulse") as typeof import("./marketPulse");

after(async () => { await db._closePoolForTests(); await inventory._closePoolForTests(); });
beforeEach(async () => { await db._resetDbForTests(); await inventory._resetDbForTests(); });

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
    { reference:"126500LN", fsCount:4, wtbCount:2, averageFsAsk:29833.33 });
  assert.equal(formatMarketPulse(pulse),
    "Market Pulse — 126500LN\n\nFS: 4 active listings\nWTB: 2 active requests\nImplied liquidity ratio: 1:2 (2 listings per buyer)\nAverage FS ask: $29,833\n\nBased on current WatchFacts inventory and dealer-group activity Fi monitors.");
});

test("pulse rejects a missing exact reference", async () => {
  await assert.rejects(getMarketPulse("   "), /exact watch reference/i);
});

test("implied liquidity ratio: more buyers than listings is expressed as buyers-per-listing", () => {
  const text = formatMarketPulse({ reference: "116500LN", fsCount: 1, wtbCount: 13, averageFsAsk: 30000 });
  assert.match(text, /Implied liquidity ratio: 13:1 \(13 buyers per listing\)/);
});

test("implied liquidity ratio: more listings than buyers is expressed as listings-per-buyer", () => {
  const text = formatMarketPulse({ reference: "116500LN", fsCount: 42, wtbCount: 1, averageFsAsk: 30000 });
  assert.match(text, /Implied liquidity ratio: 1:42 \(42 listings per buyer\)/);
});

test("implied liquidity ratio: falls back to plain English when either side is zero, rather than a ratio against zero", () => {
  assert.match(formatMarketPulse({ reference: "X", fsCount: 0, wtbCount: 5, averageFsAsk: null }), /Implied liquidity ratio: no active sellers/);
  assert.match(formatMarketPulse({ reference: "X", fsCount: 5, wtbCount: 0, averageFsAsk: 30000 }), /Implied liquidity ratio: no active buyer demand/);
  assert.match(formatMarketPulse({ reference: "X", fsCount: 0, wtbCount: 0, averageFsAsk: null }), /Implied liquidity ratio: no active listings or buyer demand/);
});

test("implied liquidity ratio also appears in the network-wide Market Overview", () => {
  const text = formatNetworkMarketSnapshot({ fsCount: 100, wtbCount: 25, averageFsAsk: 30000 });
  assert.match(text, /Implied liquidity ratio: 1:4 \(4 listings per buyer\)/);
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
    assert.deepEqual({ ...pulse, averageFsAsk: Math.round(pulse.averageFsAsk!) }, expected,
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
