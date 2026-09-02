import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "test-whapi-token";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TWILIO_ACCOUNT_SID = "AC_test";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

const channels = require("./index") as typeof import("./index");

test("sendText routes a plain (unprefixed) identity to Whapi", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await channels.sendText("15551234567", "hi");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gate\.whapi\.cloud/);
});

test("sendText routes a telegram: identity to the Telegram Bot API", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await channels.sendText("telegram:998877", "hi");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.telegram\.org/);
});

test("sendText routes an sms: identity to Twilio", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response("", { status: 201 });
  });
  await channels.sendText("sms:+15559998888", "hi");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.twilio\.com/);
});

test("sendBannerImage routes by the same identity prefix as sendText", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await channels.sendBannerImage("telegram:1", "https://cdn.example/a.jpg");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /sendPhoto$/);
});
