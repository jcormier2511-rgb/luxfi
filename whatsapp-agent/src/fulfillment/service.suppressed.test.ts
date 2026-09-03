import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// The posture this file exists to cover: testing against production data.
process.env.RESTRICT_OUTBOUND_TO = "telegram:5703391972";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const telegram = require("../channels/telegram") as typeof import("../channels/telegram");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { upsertCoverage } = require("./coverage") as typeof import("./coverage");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fulfillWtb, listCoverageAdmin } = require("./service") as typeof import("./service");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createDirectPosting } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");

after(() => db._closePoolForTests());

/**
 * Redirecting outbound contains the MESSAGE but not the outreach. Without suppression a test WTB
 * still claims every candidate dealer's opportunity — inserted ON CONFLICT DO NOTHING, so the
 * claim is permanent and that dealer can never be offered this WTB for real — still bumps their
 * coverage counters, and still sends the tester one redirected copy per dealer.
 */
test("a test WTB leaves no trace on real dealers: no claim, no counter, no send", async (t) => {
  await db._resetDbForTests();
  const sent: string[] = [];
  t.mock.method(whapiClient, "sendText", async (_p: string, body: string) => { sent.push(body); });
  t.mock.method(telegram, "sendText", async (_p: string, body: string) => { sent.push(body); });

  await upsertCoverage("15550001111", "Rolex");
  await upsertCoverage("15550002222", "Rolex");

  const wtb = await createDirectPosting({ phone: "15559990000", type: "WTB", description: "WTB Rolex", brand: "Rolex", reference: null, price: 20000 });
  const result = await fulfillWtb(wtb);

  assert.equal(result.opportunities, 0, "nobody was notified");
  assert.equal(result.suppressed, 2, "and the run still reports who would have been");

  const claims = await db.withSchema((pool) => pool.query(`SELECT 1 FROM wtb_fulfillment_opportunities WHERE wtb_posting_id=$1`, [wtb.id]));
  assert.equal(claims.rows.length, 0, "no opportunity was claimed, so these dealers can still be offered this WTB for real");

  assert.deepEqual(sent, [], "not even a redirected copy — the tester is not flooded one message per dealer");

  for (const row of await listCoverageAdmin()) {
    assert.equal(Number(row.notification_count), 0, `dealer ${row.dealer}'s counters are untouched`);
    assert.equal(row.last_notification_at, null);
  }
});

/** Suppression is about other people's inboxes, never about serving the buyer worse. */
test("the buyer's own search still runs while outreach is suppressed", async (t) => {
  await db._resetDbForTests();
  t.mock.method(whapiClient, "sendText", async () => {});
  t.mock.method(telegram, "sendText", async () => {});

  // A live FS posting the buyer's own WTB should match on.
  await db.withSchema((pool) => pool.query(`
    INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,brand,reference,price,currency,status,expires_at)
    VALUES ('whatsapp','chat','approved-group','fs-1',NULL,'FS','Rolex 116500LN for sale','Rolex','116500LN',30000,'USD','active',now()+interval '1 day')`));

  const wtb = await createDirectPosting({ phone: "15559990001", type: "WTB", description: "WTB Rolex 116500LN", brand: "Rolex", reference: "116500LN", price: 35000 });
  const result = await fulfillWtb(wtb);

  assert.equal(result.opportunities, 0, "still no dealer outreach");
  assert.ok(result.explicitMatches > 0, "but the buyer's own FS match was found and reported");
});
