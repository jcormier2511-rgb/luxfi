import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("./db") as typeof import("./db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { getMarketPulse, formatMarketPulse } = require("./marketPulse") as typeof import("./marketPulse");

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
    CREATE TABLE raw_dealer_blast (id text, reference text, type text);
    INSERT INTO raw_dealer_blast VALUES ('raw-only','126500LN','FS');
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
    "Market Pulse — 126500LN\n\nFS: 4 active listings\nWTB: 2 active requests\nAverage FS ask: $29,833\n\nBased on current activity across the dealer groups and WatchFacts inventory Fi monitors.");
});

test("pulse rejects a missing exact reference", async () => {
  await assert.rejects(getMarketPulse("   "), /exact watch reference/i);
});
