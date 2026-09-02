import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-whapi-status-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("./whapi/client") as typeof import("./whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");

const app = createServer();
let httpServer: Server;
let baseUrl = "";

before(async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("GET /admin/whapi-status rejects a missing or wrong token", async () => {
  const missing = await fetch(`${baseUrl}/admin/whapi-status`);
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${baseUrl}/admin/whapi-status?token=wrong`);
  assert.equal(wrong.status, 401);
});

test("GET /admin/whapi-status passes through checkWhapiHealth's result, including an unauthorized channel", async (t) => {
  t.mock.method(whapiClient, "checkWhapiHealth", async () => ({
    configured: true,
    reachable: true,
    authorized: false,
    statusText: "UNAUTH",
    version: "2.0",
    error: null,
  }));

  const res = await fetch(`${baseUrl}/admin/whapi-status?token=test-webhook-token`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.authorized, false);
  assert.equal(body.statusText, "UNAUTH");
});
