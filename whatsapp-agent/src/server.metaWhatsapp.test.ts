import crypto from "crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "http";
import type { AddressInfo } from "net";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test("GET /webhook/whatsapp completes Meta verification", async () => {
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-me";
  const response = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=challenge-123`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type")?.startsWith("text/plain"), true);
  assert.equal(await response.text(), "challenge-123");
});

test("GET /webhook/whatsapp rejects a bad verification token", async () => {
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-me";
  const response = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  assert.equal(response.status, 403);
});

test("GET /webhook/whatsapp fails closed without a verification token", async () => {
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const response = await fetch(`${baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=x`);
  assert.equal(response.status, 503);
});

test("POST /webhook/whatsapp accepts an exact raw-body signature", async () => {
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const signature = `sha256=${crypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`;
  const response = await fetch(`${baseUrl}/webhook/whatsapp`, { method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body });
  assert.equal(response.status, 200);
});

test("POST /webhook/whatsapp rejects an invalid signature", async () => {
  process.env.WHATSAPP_APP_SECRET = "app-secret";
  const response = await fetch(`${baseUrl}/webhook/whatsapp`, { method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    body: JSON.stringify({ entry: [] }) });
  assert.equal(response.status, 401);
});
