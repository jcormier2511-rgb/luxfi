import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "mg-debug-admin-token";
process.env.WHAPI_TOKEN = "";

const { createServer } = require("./server") as typeof import("./server");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const rates = require("./fx/rates") as typeof import("./fx/rates");

const TOKEN = "mg-debug-admin-token";
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await postingsDb._resetDbForTests();
  await inventoryDb._resetDbForTests();
  rates._setRatesForTests({ base: "USD", rates: { USD: 1, HKD: 8, EUR: 0.9 }, fetchedAt: new Date() });
  const app = createServer();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  rates._resetRatesForTests();
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
});

test("shows the raw currency and USD conversion behind every comparable row for a reference", async () => {
  await postingsDb.withSchema((pool) =>
    pool.query(
      `INSERT INTO postings (source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
       VALUES ('whatsapp','chat','other-group','mg-debug-1',NULL,'FS','fixture','116500LN',192000,'HKD','active',now()+interval '1 day')`
    )
  );

  const res = await fetch(`${baseUrl}/admin/market-guide/debug?reference=116500LN&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; canonicalReference: string; rows: { rawAmount: number; rawCurrency: string; amountUsd: number | null }[] };
  assert.equal(body.ok, true);
  assert.equal(body.canonicalReference, "116500LN");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].rawAmount, 192000);
  assert.equal(body.rows[0].rawCurrency, "HKD");
  assert.ok(body.rows[0].amountUsd !== null && body.rows[0].amountUsd < 192000, "HKD must actually be converted down, never treated as USD");
});

test("is admin-token gated and requires a reference", async () => {
  assert.equal((await fetch(`${baseUrl}/admin/market-guide/debug?reference=116500LN&token=wrong`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/admin/market-guide/debug?token=${TOKEN}`)).status, 400);
});
