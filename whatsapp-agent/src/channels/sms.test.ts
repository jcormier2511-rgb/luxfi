import crypto from "crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

const sms = require("./sms") as typeof import("./sms");

test("sendText posts a form-encoded message to Twilio with the phone resolved from an sms: identity", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: 201 });
  });
  await sms.sendText("sms:+15559998888", "hello there");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json");
  const params = new URLSearchParams(calls[0].init.body as string);
  assert.equal(params.get("To"), "+15559998888");
  assert.equal(params.get("From"), "+15550000000");
  assert.equal(params.get("Body"), "hello there");
  assert.match((calls[0].init.headers as Record<string, string>).Authorization, /^Basic /);
});

test("sendBannerImage includes MediaUrl and is a no-op for an empty imageUrl", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("", { status: 201 });
  });
  await sms.sendBannerImage("sms:+15551112222", "https://cdn.example/a.jpg", "caption");
  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].init.body as string);
  assert.equal(params.get("MediaUrl"), "https://cdn.example/a.jpg");
  assert.equal(params.get("Body"), "caption");

  await sms.sendBannerImage("sms:+15551112222", "");
  assert.equal(calls.length, 1, "no call for an empty imageUrl");
});

test("sendText throws when Twilio returns a non-2xx response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("bad request", { status: 400 }));
  await assert.rejects(() => sms.sendText("sms:+15550001111", "hi"), /Twilio send failed: 400/);
});

function sign(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", "test-twilio-auth-token").update(data, "utf8").digest("base64");
}

test("verifyTwilioSignature accepts a correctly signed request and rejects a tampered one or a missing header", () => {
  const url = "https://fi.example.test/webhook/sms";
  const params = { From: "+15551234567", Body: "hello", MessageSid: "SM1" };
  const goodSig = sign(url, params);
  assert.equal(sms.verifyTwilioSignature(url, params, goodSig), true);
  assert.equal(sms.verifyTwilioSignature(url, { ...params, Body: "tampered" }, goodSig), false);
  assert.equal(sms.verifyTwilioSignature(url, params, undefined), false);
});

test("extractIncomingMessage normalizes a plain SMS into sms: identity form", () => {
  const message = sms.extractIncomingMessage({ From: "+15559998888", Body: "  FS Rolex Daytona 116500LN $18500  ", MessageSid: "SM2" });
  assert.ok(message);
  assert.equal(message!.id, "SM2");
  assert.equal(message!.phone, "sms:+15559998888");
  assert.equal(message!.text, "FS Rolex Daytona 116500LN $18500");
  assert.equal(message!.isGroup, false);
  assert.equal(message!.imageUrl, undefined);
});

test("extractIncomingMessage picks up MMS media directly (no extra resolution call needed, unlike Telegram)", () => {
  const message = sms.extractIncomingMessage({
    From: "+15559998888",
    Body: "photo attached",
    MessageSid: "SM3",
    NumMedia: "1",
    MediaUrl0: "https://api.twilio.com/media/abc123",
  });
  assert.equal(message!.imageUrl, "https://api.twilio.com/media/abc123");
});

test("extractIncomingMessage returns null when required fields are missing", () => {
  assert.equal(sms.extractIncomingMessage({ Body: "no From or MessageSid" }), null);
});
