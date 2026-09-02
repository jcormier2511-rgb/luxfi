import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "test-whapi-token";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TWILIO_ACCOUNT_SID = "AC_test";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";
// The safety valve under test — must be set before config.ts is first required.
process.env.RESTRICT_OUTBOUND_TO = "15550001111";

const channels = require("./index") as typeof import("./index");

function jsonBody(init: RequestInit | undefined): any {
  return JSON.parse(String(init?.body ?? "{}"));
}

test("sendText to a non-allowed identity is redirected to the allowed one, noting the real recipient", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({}), { status: 200 });
  });

  await channels.sendText("19998887777", "Potential Match — Rolex Daytona");

  assert.equal(calls.length, 1);
  const body = jsonBody(calls[0].init);
  assert.equal(body.to, "15550001111", "must land on the allowed identity, never the real recipient");
  assert.match(body.body, /Redirected — was for 19998887777 via whatsapp/);
  assert.match(body.body, /Potential Match — Rolex Daytona/, "the original message content must still be visible, just redirected");
});

test("sendText to the allowed identity itself is delivered unchanged, with no redirect note", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({}), { status: 200 });
  });

  await channels.sendText("15550001111", "hello");

  assert.equal(calls.length, 1);
  const body = jsonBody(calls[0].init);
  assert.equal(body.to, "15550001111");
  assert.equal(body.body, "hello");
});

test("sendText redirects across channels too — a telegram-bound message still lands on the allowed WhatsApp identity", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({}), { status: 200 });
  });

  await channels.sendText("telegram:998877", "hi from telegram");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gate\.whapi\.cloud/, "redirected sends still route by the ALLOWED identity's own platform");
  const body = jsonBody(calls[0].init);
  assert.equal(body.to, "15550001111");
  assert.match(body.body, /Redirected — was for telegram:998877 via telegram/);
});

test("sendBannerImage redirects a caption-less image with a visible redirect note instead of dropping it silently", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({}), { status: 200 });
  });

  await channels.sendBannerImage("19998887777", "https://cdn.example/a.jpg");

  assert.equal(calls.length, 1);
  const body = jsonBody(calls[0].init);
  assert.equal(body.to, "15550001111");
  assert.match(body.caption, /Redirected — was for 19998887777 via whatsapp/);
});
