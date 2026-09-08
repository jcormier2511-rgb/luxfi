import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIncomingMessages, IncomingWebhook } from "./client";

function webhook(messages: IncomingWebhook["messages"]): IncomingWebhook {
  return { messages };
}

test("required: an image message with no caption is no longer dropped — a seller's bare photo reply must be captured", () => {
  const [msg] = extractIncomingMessages(
    webhook([{ id: "m1", from_me: false, type: "image", chat_id: "15551234567", from: "15551234567", image: { link: "https://cdn.example/a.jpg" } }])
  );
  assert.ok(msg, "an uncaptioned image must still produce a message");
  assert.equal(msg.imageUrl, "https://cdn.example/a.jpg");
  assert.equal(msg.text, "", "no caption means empty text, not a dropped message");
});

test("an image message WITH a caption keeps using the caption as its text, unchanged", () => {
  const [msg] = extractIncomingMessages(
    webhook([
      {
        id: "m2",
        from_me: false,
        type: "image",
        chat_id: "15551234567",
        from: "15551234567",
        image: { link: "https://cdn.example/b.jpg", caption: "FS: Rolex Daytona" },
      },
    ])
  );
  assert.equal(msg.text, "FS: Rolex Daytona");
  assert.equal(msg.imageUrl, "https://cdn.example/b.jpg");
});

test("an image message with no link at all is still dropped — there's nothing to act on", () => {
  const messages = extractIncomingMessages(webhook([{ id: "m3", from_me: false, type: "image", chat_id: "15551234567", from: "15551234567", image: {} }]));
  assert.equal(messages.length, 0);
});

test("a from_me image (the bot's own outgoing message echoed back) is still ignored", () => {
  const messages = extractIncomingMessages(
    webhook([{ id: "m4", from_me: true, type: "image", chat_id: "15551234567", from: "15551234567", image: { link: "https://cdn.example/c.jpg" } }])
  );
  assert.equal(messages.length, 0);
});

test("required regression: a document (or any other non-text/non-image message type) is no longer silently dropped — a .psd sent during an active step got zero reply at all, indistinguishable from the bot being stuck", () => {
  const [msg] = extractIncomingMessages(
    webhook([{ id: "m6", from_me: false, type: "document", chat_id: "15551234567", from: "15551234567" }])
  );
  assert.ok(msg, "a document must still produce a message so the active flow's own fallback can respond");
  assert.equal(msg.text, "", "we don't know how to extract text from an arbitrary document type");
  assert.equal(msg.imageUrl, undefined, "not treated as a photo — most document types genuinely aren't one");
});

test("required regression: a reaction (emoji double-tap on an earlier message) is dropped entirely, not treated as a content-less message — reacting to Fi's own reply produced a spurious \"I'm not sure I understood that\" right after a correct answer", () => {
  const messages = extractIncomingMessages(
    webhook([{ id: "m7", from_me: false, type: "reaction", chat_id: "15551234567", from: "15551234567" }])
  );
  assert.equal(messages.length, 0, "a bare gesture must never reach the conversation flow's fallback");
});

test("extractIncomingMessages extracts a shared location pin, with no text needed to keep the message", () => {
  const [msg] = extractIncomingMessages(
    webhook([{ id: "m8", from_me: false, type: "location", chat_id: "15551234567", from: "15551234567", location: { latitude: 25.7617, longitude: -80.1918 } }])
  );
  assert.ok(msg, "a bare location share must still produce a message, the same as an uncaptioned photo/document");
  assert.deepEqual(msg.location, { latitude: 25.7617, longitude: -80.1918 });
  assert.equal(msg.text, "");
});

test("a location message with no coordinates at all still produces a message, just with no location extracted", () => {
  const [msg] = extractIncomingMessages(
    webhook([{ id: "m9", from_me: false, type: "location", chat_id: "15551234567", from: "15551234567", location: {} }])
  );
  assert.ok(msg);
  assert.equal(msg.location, undefined);
});

test("plain text messages are unaffected by the image-filter change", () => {
  const [msg] = extractIncomingMessages(
    webhook([{ id: "m5", from_me: false, type: "text", chat_id: "15551234567", from: "15551234567", text: { body: "buy: Rolex Daytona" } }])
  );
  assert.equal(msg.text, "buy: Rolex Daytona");
  assert.equal(msg.imageUrl, undefined);
});
