import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { upsertCoverage } = require("./coverage") as typeof import("./coverage");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fulfillWtb } = require("./service") as typeof import("./service");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createDirectPosting } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const urlValidator = require("../watchfacts/urlValidator") as typeof import("../watchfacts/urlValidator");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");

after(async () => { await db._closePoolForTests(); await inventory._closePoolForTests(); });

/**
 * Live-reported: notifying one dealer with a broken/unregistered number ("Whapi 404 Channel not
 * found") threw all the way up through fulfillWtb, out of ingestDirectBuyPosting, and crashed the
 * BUYER's own "confirm" turn — they never got their own "Your WTB request is active"
 * acknowledgment because a completely unrelated dealer's number was bad.
 */
test("a dealer notification failure never stops notifying the OTHER dealers, and never throws", async (t) => {
  await db._resetDbForTests();
  await upsertCoverage("15550001111", "Rolex"); // dealer A -- will fail to deliver
  await upsertCoverage("15550002222", "Rolex"); // dealer B -- will succeed

  t.mock.method(whapiClient, "sendText", async (phone: string) => {
    if (phone === "15550001111") throw new Error("Whapi /messages/text failed: 404 Channel not found");
  });

  const wtb = await createDirectPosting({ phone: "15559990000", type: "WTB", description: "WTB Rolex", brand: "Rolex", reference: null, price: 20000 });

  const result = await fulfillWtb(wtb);
  assert.equal(result.opportunities, 1, "the failed dealer doesn't count, but the successful one still does");

  const opportunities = await db.withSchema((pool) => pool.query(`SELECT dealer_canonical_user_id FROM wtb_fulfillment_opportunities WHERE wtb_posting_id=$1`, [wtb.id]));
  assert.equal(opportunities.rows.length, 2, "both opportunities are still recorded, even the one whose notification failed to send");
});

/**
 * A dealer reached through known_inventory was matched because of ONE specific listing of
 * theirs, and the outreach never said which. "New WTB opportunity — Rolex" leaves a dealer with
 * a hundred Rolexes no way to know what Fi is actually asking about.
 */
test("a known-inventory dealer is shown the listing of theirs that matched, by link", async (t) => {
  await db._resetDbForTests();
  await inventory._resetDbForTests();
  const sent: string[] = [];
  t.mock.method(whapiClient, "sendText", async (_phone: string, body: string) => { sent.push(body); });
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200 }) as Response);
  urlValidator._clearUrlValidationCacheForTests();

  await inventory.upsertListings([{
    id: "wf-dealer-1", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
    condition: "new", price: "$34,000", location: "USA", contactName: "Dealer", contactPhone: "15550003333",
    rating: "", description: "", detailUrl: "https://watchfacts.com/flash-sales/wf-dealer-1",
  }], new Date().toISOString());
  await getOrCreateCanonicalUser("whatsapp", "15550003333");

  const wtb = await createDirectPosting({ phone: "15559990001", type: "WTB", description: "WTB Rolex 116500LN", brand: "Rolex", reference: "116500LN", price: 35000 });
  const result = await fulfillWtb(wtb);

  assert.equal(result.opportunities, 1);
  assert.match(sent[0], /Your matching listing \(116500LN\):\nhttps:\/\/watchfacts\.com\/flash-sales\/wf-dealer-1/);
});

test("a coverage dealer registered an interest, not a listing, so no link block is invented for them", async (t) => {
  await db._resetDbForTests();
  await inventory._resetDbForTests();
  const sent: string[] = [];
  t.mock.method(whapiClient, "sendText", async (_phone: string, body: string) => { sent.push(body); });

  await upsertCoverage("15550004444", "Rolex");
  const wtb = await createDirectPosting({ phone: "15559990002", type: "WTB", description: "WTB Rolex", brand: "Rolex", reference: null, price: 20000 });
  await fulfillWtb(wtb);

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Your matching listing/);
});

test("an unreachable listing link is dropped rather than sent broken", async (t) => {
  await db._resetDbForTests();
  await inventory._resetDbForTests();
  const sent: string[] = [];
  t.mock.method(whapiClient, "sendText", async (_phone: string, body: string) => { sent.push(body); });
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 }) as Response);
  urlValidator._clearUrlValidationCacheForTests();

  await inventory.upsertListings([{
    id: "wf-dead", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
    condition: "new", price: "$34,000", location: "USA", contactName: "Dealer", contactPhone: "15550005555",
    rating: "", description: "", detailUrl: "https://watchfacts.com/flash-sales/wf-dead",
  }], new Date().toISOString());
  await getOrCreateCanonicalUser("whatsapp", "15550005555");

  const wtb = await createDirectPosting({ phone: "15559990003", type: "WTB", description: "WTB Rolex 116500LN", brand: "Rolex", reference: "116500LN", price: 35000 });
  await fulfillWtb(wtb);

  assert.equal(sent.length, 1, "the dealer is still notified — only the broken link is withheld");
  assert.doesNotMatch(sent[0], /watchfacts\.com/);
});

test("a dealer whose only listing is past the freshness window is not asked to fulfil from it", async (t) => {
  await db._resetDbForTests();
  await inventory._resetDbForTests();
  const sent: string[] = [];
  t.mock.method(whapiClient, "sendText", async (_phone: string, body: string) => { sent.push(body); });

  await inventory.upsertListings([{
    id: "wf-old", type: "FS", category: "watches", item: "Daytona", brand: "Rolex", ref: "116500LN",
    condition: "new", price: "$34,000", location: "USA", contactName: "Dealer", contactPhone: "15550006666",
    rating: "", description: "", detailUrl: "https://watchfacts.com/flash-sales/wf-old",
  }], new Date(Date.now() - 40 * 86400000).toISOString());
  await getOrCreateCanonicalUser("whatsapp", "15550006666");

  const wtb = await createDirectPosting({ phone: "15559990004", type: "WTB", description: "WTB Rolex 116500LN", brand: "Rolex", reference: "116500LN", price: 35000 });
  const result = await fulfillWtb(wtb);

  assert.equal(result.opportunities, 0, "a 40-day-old listing is not evidence the dealer still has the watch");
  assert.deepEqual(sent, []);
});
