import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import type { Server } from "http";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "schema-admin-token";
process.env.WHAPI_TOKEN = "";
delete process.env.WATCHFACTS_DB_URL;

const { createServer } = require("./server") as typeof import("./server");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");

const TOKEN = "schema-admin-token";
let httpServer: Server;
let baseUrl = "";

before(async () => {
  const app = createServer();
  await new Promise<void>((resolve) => { httpServer = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await postingsDb._closePoolForTests();
  await inventoryDb._closePoolForTests();
});

test("the schema endpoint is admin-token gated", async () => {
  for (const q of ["", "?token=", "?token=wrong"]) {
    assert.equal((await fetch(`${baseUrl}/admin/watchfacts/source-schema${q}`)).status, 401, `"${q}"`);
  }
});

test("with no WATCHFACTS_DB_URL it says so rather than failing obscurely", async () => {
  const res = await fetch(`${baseUrl}/admin/watchfacts/source-schema?token=${TOKEN}`);
  assert.equal(res.status, 400);
  assert.match((await res.json() as { error: string }).error, /WATCHFACTS_DB_URL is not set/);
});

test("table names are restricted to identifiers — no SQL can ride in on ?table=", async () => {
  const { config } = require("./config") as typeof import("./config");
  const original = config.watchfacts.sourceDbUrl;
  (config.watchfacts as { sourceDbUrl: string }).sourceDbUrl = "postgres://u:p@localhost:1/x";
  try {
    const res = await fetch(`${baseUrl}/admin/watchfacts/source-schema?token=${TOKEN}&table=${encodeURIComponent("auctions; DROP TABLE users")}`);
    assert.equal(res.status, 400);
    assert.match((await res.json() as { error: string }).error, /letters, digits and underscores/);
  } finally {
    (config.watchfacts as { sourceDbUrl: string }).sourceDbUrl = original;
  }
});
