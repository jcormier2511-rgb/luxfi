import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "purge-admin-token";
process.env.WHAPI_TOKEN = "";

const { createServer } = require("./server") as typeof import("./server");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const { createDirectPosting, getActivePostingsForUser, getPosting } = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
const { getOrCreateCanonicalUser } = require("./postings/identity") as typeof import("./postings/identity");
const { platformForIdentity } = require("./channels/identity") as typeof import("./channels/identity");

const TOKEN = "purge-admin-token";
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

test("purging one identity retires all of its active postings as admin_closed and touches nobody else's", async () => {
  const tester = "telegram:5703391972";
  const other = "15550009999";
  // The junk pre-fix testing left behind, plus a legitimate listing on another account.
  const a = await createDirectPosting({ phone: tester, type: "WTB", description: "WTB rolex i want ot buy a", brand: "rolex", reference: null, price: 25000 });
  const b = await createDirectPosting({ phone: tester, type: "WTB", description: "WTB rolex 38000", brand: "rolex", reference: "38000", price: 38000 });
  const keep = await createDirectPosting({ phone: other, type: "FS", description: "FS Rolex 116500LN", brand: "rolex", reference: "116500LN", price: 30000 });

  const res = await fetch(`${baseUrl}/admin/postings/purge?phone=${encodeURIComponent(tester)}&token=${TOKEN}`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; identity: string; closed: { id: number }[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.closed.map((c) => c.id).sort(), [a.id, b.id].sort(), "reports exactly what it closed");

  const testerId = await getOrCreateCanonicalUser(platformForIdentity(tester), tester);
  assert.deepEqual(await getActivePostingsForUser(testerId), [], "nothing active remains on the purged identity");
  assert.equal((await getPosting(a.id))?.status, "admin_closed", "closed with a reason, not deleted");

  const otherId = await getOrCreateCanonicalUser(platformForIdentity(other), other);
  assert.equal((await getActivePostingsForUser(otherId)).length, 1, "another account's listing is untouched");
  assert.equal((await getPosting(keep.id))?.status, "active");
});

test("the purge is admin-token gated and refuses to run without an identity", async () => {
  assert.equal((await fetch(`${baseUrl}/admin/postings/purge?phone=telegram:1&token=wrong`, { method: "POST" })).status, 401);
  const noPhone = await fetch(`${baseUrl}/admin/postings/purge?token=${TOKEN}`, { method: "POST" });
  assert.equal(noPhone.status, 400, "there is deliberately no purge-everything");
});
