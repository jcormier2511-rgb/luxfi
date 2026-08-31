import crypto from "crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-telegram-sms-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token";
process.env.WHAPI_TOKEN = "";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token-xyz";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-telegram-secret-xyz";
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token-xyz";
process.env.TWILIO_FROM_NUMBER = "+15550000000";
process.env.TWILIO_WEBHOOK_BASE_URL = "https://fi.example.test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");

const app = createServer();
let httpServer: Server;
let baseUrl = "";
const realFetch = globalThis.fetch;

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

/** Passes local-server requests straight through to the real fetch; records and fakes any call
 *  to an external provider (Telegram/Twilio) so tests can assert on outbound sends without a
 *  real network call. */
function interceptOutboundFetch(t: any, matchHost: RegExp, fakeResponse: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (!matchHost.test(url)) return realFetch(url, init);
    calls.push({ url, init });
    return fakeResponse();
  });
  return calls;
}

function twilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", "test-twilio-auth-token-xyz").update(data, "utf8").digest("base64");
}

test("POST /webhook/telegram rejects a missing or wrong secret header", async () => {
  const update = { update_id: 1, message: { message_id: 1, chat: { id: 111, type: "private" }, text: "help" } };
  const missing = await fetch(`${baseUrl}/webhook/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${baseUrl}/webhook/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: JSON.stringify(update),
  });
  assert.equal(wrong.status, 401);
});

test("a correctly authenticated Telegram \"help\" message gets the Fi menu back via sendMessage", async (t) => {
  const calls = interceptOutboundFetch(t, /api\.telegram\.org/, () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

  const update = { update_id: 2, message: { message_id: 2, from: { id: 222333, first_name: "Ada" }, chat: { id: 222333, type: "private" }, text: "help" } };
  const res = await fetch(`${baseUrl}/webhook/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "test-telegram-secret-xyz" },
    body: JSON.stringify(update),
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.chat_id, "222333");
  assert.match(body.text, /here's what I can do/);
});

test("the Telegram sender's canonical identity is recorded tagged as platform='telegram', not 'whatsapp'", async (t) => {
  interceptOutboundFetch(t, /api\.telegram\.org/, () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

  const update = { update_id: 3, message: { message_id: 3, from: { id: 555666 }, chat: { id: 555666, type: "private" }, text: "status" } };
  await fetch(`${baseUrl}/webhook/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": "test-telegram-secret-xyz" },
    body: JSON.stringify(update),
  });
  await new Promise((r) => setTimeout(r, 200));

  const { getOrCreateCanonicalUser } = require("./postings/identity") as typeof import("./postings/identity");
  const { platformForIdentity } = require("./channels/identity") as typeof import("./channels/identity");
  const identity = "telegram:555666";
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(identity), identity);
  const { withSchema } = require("./postings/db") as typeof import("./postings/db");
  const row = await withSchema((pool: any) =>
    pool.query("SELECT platform FROM linked_identities WHERE canonical_user_id=$1", [canonicalUserId])
  ) as { rows: { platform: string }[] };
  assert.equal(row.rows[0].platform, "telegram");
});

test("POST /webhook/sms rejects an unsigned or badly signed request", async () => {
  const params = { From: "+15551234567", Body: "help", MessageSid: "SM1" };
  const noSig = await fetch(`${baseUrl}/webhook/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  assert.equal(noSig.status, 401);

  const badSig = await fetch(`${baseUrl}/webhook/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": "bogus" },
    body: new URLSearchParams(params).toString(),
  });
  assert.equal(badSig.status, 401);
});

test("a correctly signed SMS \"help\" message gets the Fi menu back via Twilio's Messages API", async (t) => {
  const calls = interceptOutboundFetch(t, /api\.twilio\.com/, () => new Response("", { status: 201 }));

  const params = { From: "+15559998888", Body: "help", MessageSid: "SM2" };
  const url = "https://fi.example.test/webhook/sms";
  const res = await fetch(`${baseUrl}/webhook/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(url, params) },
    body: new URLSearchParams(params).toString(),
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 1);
  const body = new URLSearchParams(calls[0].init.body as string);
  assert.equal(body.get("To"), "+15559998888");
  assert.match(body.get("Body") ?? "", /here's what I can do/);
});
