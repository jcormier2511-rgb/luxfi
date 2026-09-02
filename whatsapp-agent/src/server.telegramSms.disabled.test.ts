import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-telegram-sms-disabled-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token";
process.env.WHAPI_TOKEN = "";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_WEBHOOK_SECRET;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
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

// No fetch mocking here (unlike the other channel tests): the whole point of these two tests
// is that an unconfigured channel bails out with 503 BEFORE ever attempting an outbound call —
// the test's own fetch to the local server must reach it untouched, so global fetch stays real.

test("POST /webhook/telegram reports 503 (not open, not a crash) while TELEGRAM_WEBHOOK_SECRET is unset", async () => {
  const res = await fetch(`${baseUrl}/webhook/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "help" } }),
  });
  assert.equal(res.status, 503);
});

test("POST /webhook/sms reports 503 (not open, not a crash) while TWILIO_AUTH_TOKEN is unset", async () => {
  const res = await fetch(`${baseUrl}/webhook/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+15551234567", Body: "help", MessageSid: "SM1" }).toString(),
  });
  assert.equal(res.status, 503);
});
