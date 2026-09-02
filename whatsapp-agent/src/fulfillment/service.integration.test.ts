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

after(() => db._closePoolForTests());

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
