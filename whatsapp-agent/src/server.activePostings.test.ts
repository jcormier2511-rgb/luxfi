import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "active-postings-admin-token";
process.env.WHAPI_TOKEN = "";

const { createServer } = require("./server") as typeof import("./server");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const { createDirectPosting } = require("./postings/postingsStore") as typeof import("./postings/postingsStore");

const TOKEN = "active-postings-admin-token";
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await postingsDb._resetDbForTests();
  const app = createServer();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
});

/**
 * Built to actually answer a real, live-reported question a one-line morning-briefing summary
 * can't: why a broad "any Rolex Daytona" WTB showed fewer matches than its own more specific
 * sibling ("Daytona 116500LN") that it should logically be a superset of -- by exposing the REAL
 * stored fields (reference, budget, dial, condition) behind that summary line, not just an
 * aggregate count.
 */
test("required: GET /admin/api/postings/active groups active postings by type, scoped to a phone when given", async () => {
  await createDirectPosting({ phone: "15559990101", type: "WTB", description: "WTB Rolex Daytona", brand: "Rolex", model: "Daytona", reference: null, price: 30000 });
  await createDirectPosting({ phone: "15559990101", type: "FS", description: "FS Rolex Submariner", brand: "Rolex", model: "Submariner", reference: null, price: 12000 });
  await createDirectPosting({ phone: "15559990202", type: "WTB", description: "WTB Patek 5711", brand: "Patek", model: "5711", reference: null, price: 90000 });

  const res = await fetch(`${baseUrl}/admin/api/postings/active?token=${TOKEN}&phone=15559990101`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; WTB: { brand: string }[]; FS: { brand: string }[] };
  assert.equal(body.ok, true);
  assert.equal(body.WTB.length, 1);
  assert.equal(body.WTB[0].brand, "Rolex");
  assert.equal(body.FS.length, 1);
  assert.equal(body.FS[0].brand, "Rolex");
});

test("required: GET /admin/api/postings/active rejects a missing/wrong admin token", async () => {
  const missing = await fetch(`${baseUrl}/admin/api/postings/active`);
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${baseUrl}/admin/api/postings/active?token=wrong`);
  assert.equal(wrong.status, 401);
});
