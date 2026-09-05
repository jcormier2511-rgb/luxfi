import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token-123";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-telegram-secret";

const telegram = require("./telegram") as typeof import("./telegram");

test("sendText posts to the Bot API with the chat id resolved from a telegram: identity", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await telegram.sendText("telegram:445566", "hello there");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottest-bot-token-123/sendMessage");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.chat_id, "445566");
  assert.equal(body.text, "hello there");
});

test("sendBannerImage posts to sendPhoto and is a no-op for an empty imageUrl", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });
  await telegram.sendBannerImage("telegram:1", "https://cdn.example/a.jpg", "caption text");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendPhoto$/);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.photo, "https://cdn.example/a.jpg");
  assert.equal(body.caption, "caption text");

  await telegram.sendBannerImage("telegram:1", "");
  assert.equal(calls.length, 1, "no call for an empty imageUrl");
});

test("sendText throws when the Bot API returns ok:false", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 200 }));
  await assert.rejects(() => telegram.sendText("telegram:999", "hi"), /Telegram sendMessage failed/);
});

test("verifyTelegramSecret rejects a missing/wrong header and accepts the configured secret", () => {
  assert.equal(telegram.verifyTelegramSecret("test-telegram-secret"), true);
  assert.equal(telegram.verifyTelegramSecret("wrong-secret"), false);
  assert.equal(telegram.verifyTelegramSecret(undefined), false);
});

function privateMessage(overrides: Partial<{ text: string; caption: string; photo: { file_id: string }[] }> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      from: { id: 778899, first_name: "Ada" },
      chat: { id: 778899, type: "private" },
      ...overrides,
    },
  };
}

test("extractIncomingMessages normalizes a private text message into telegram: identity form", async () => {
  const [msg] = await telegram.extractIncomingMessages(privateMessage({ text: "FS Rolex Daytona 116500LN $18500" }));
  assert.ok(msg);
  assert.equal(msg.id, "telegram:778899:42", "namespaced by chat id so two different chats' message_id 42 never collide");
  assert.equal(msg.phone, "telegram:778899");
  assert.equal(msg.text, "FS Rolex Daytona 116500LN $18500");
  assert.equal(msg.isGroup, false);
  assert.equal(msg.senderName, "Ada");
});

test("two different chats' first messages (both message_id 1) get distinct normalized ids, not a collision", async () => {
  const firstChatMessage = { update_id: 10, message: { message_id: 1, from: { id: 111 }, chat: { id: 111, type: "private" }, text: "hi" } };
  const secondChatMessage = { update_id: 11, message: { message_id: 1, from: { id: 222 }, chat: { id: 222, type: "private" }, text: "hi" } };

  const [msgA] = await telegram.extractIncomingMessages(firstChatMessage);
  const [msgB] = await telegram.extractIncomingMessages(secondChatMessage);
  assert.notEqual(msgA.id, msgB.id, "the shared alreadyProcessed dedup store must never see these two as the same message");
});

test("extractIncomingMessages drops group/channel chats entirely — group monitoring stays WhatsApp-only", async () => {
  const groupUpdate = {
    update_id: 2,
    message: { message_id: 1, from: { id: 1 }, chat: { id: -100123, type: "group" }, text: "FS Rolex 116500LN" },
  };
  const messages = await telegram.extractIncomingMessages(groupUpdate);
  assert.equal(messages.length, 0);
});

test("extractIncomingMessages resolves a photo's file_id to a downloadable URL via getFile", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /getFile$/);
    return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg" } }), { status: 200 });
  });
  const [msg] = await telegram.extractIncomingMessages(privateMessage({ caption: "FS watch", photo: [{ file_id: "small" }, { file_id: "largest" }] }));
  assert.ok(msg);
  assert.equal(msg.text, "FS watch");
  assert.equal(msg.imageUrl, "https://api.telegram.org/file/bottest-bot-token-123/photos/file_1.jpg");
});

test("required regression: a document (e.g. a .psd) with no caption is no longer silently dropped — it got zero reply at all during an active step, indistinguishable from the bot being stuck", async () => {
  const update = privateMessage({ document: { file_id: "doc1", file_name: "Untitled-1.psd", mime_type: "image/vnd.adobe.photoshop" } } as Partial<{ text: string; caption: string; photo: { file_id: string }[] }>);
  const [msg] = await telegram.extractIncomingMessages(update);
  assert.ok(msg, "a document must still produce a message so the active flow's own fallback can respond");
  assert.equal(msg.text, "", "we don't know how to extract text from an arbitrary document type");
  assert.equal(msg.imageUrl, undefined, "not treated as a photo — most document types genuinely aren't one");
});

test("extractIncomingMessages returns [] for an update with neither a text/caption nor a photo", async () => {
  const update = { update_id: 3, message: { message_id: 1, chat: { id: 1, type: "private" } } };
  const messages = await telegram.extractIncomingMessages(update);
  assert.equal(messages.length, 0);
});

test("extractIncomingMessages returns [] for an update with no message at all (e.g. an edited_message or other update type)", async () => {
  const messages = await telegram.extractIncomingMessages({ update_id: 4 });
  assert.equal(messages.length, 0);
});
