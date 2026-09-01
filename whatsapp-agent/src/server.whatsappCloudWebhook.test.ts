import crypto from "crypto";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "http";
import type { AddressInfo } from "net";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "meta-verify-token";
process.env.WHATSAPP_APP_SECRET = "meta-app-secret";

const adminStore = require("./admin/store") as typeof import("./admin/store");
adminStore.initAdminSchema = async () => undefined;
const { createServer } = require("./server") as typeof import("./server");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const postingsDb = require("./postings/db") as typeof import("./postings/db");

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
});

function signature(body: string): string {
  return `sha256=${crypto.createHmac("sha256", "meta-app-secret").update(body).digest("hex")}`;
}

test("GET /webhook/whatsapp returns Meta's challenge for the configured verification token", async () => {
  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "meta-verify-token",
    "hub.challenge": "challenge-123",
  });
  const response = await fetch(`${baseUrl}/webhook/whatsapp?${query}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge-123");
});

test("GET /webhook/whatsapp rejects an incorrect token or mode", async () => {
  for (const query of [
    "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123",
    "hub.mode=wrong&hub.verify_token=meta-verify-token&hub.challenge=123",
  ]) {
    assert.equal((await fetch(`${baseUrl}/webhook/whatsapp?${query}`)).status, 403);
  }
});

test("POST /webhook/whatsapp validates X-Hub-Signature-256 against the raw body", async () => {
  const body = '{ "object": "whatsapp_business_account", "entry": [] }';
  const response = await fetch(`${baseUrl}/webhook/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature(body) },
    body,
  });
  assert.equal(response.status, 200);
});

test("POST /webhook/whatsapp rejects missing, malformed, and wrong signatures", async () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  for (const header of [undefined, "bogus", signature(`${body} `)]) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (header) headers["x-hub-signature-256"] = header;
    const response = await fetch(`${baseUrl}/webhook/whatsapp`, { method: "POST", headers, body });
    assert.equal(response.status, 401);
  }
});
