import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// Deliberately left unset, same posture as whapi/client.health.disabled.test.ts -- confirms the
// module fails safe (skip-and-log, never a live call or a thrown error) rather than guessing at
// credentials, both for outbound sends and for resolving a received image's media id.
delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;

const client = require("./whatsappCloud") as typeof import("./whatsappCloud");

test("sendText skips the live call and warns when unconfigured, without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendText("15551234567", "hi");
});

test("sendBannerImage skips the live call and warns when unconfigured, without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  await client.sendBannerImage("15551234567", "https://cdn.example/a.jpg", "caption");
});

test("extractIncomingMessages never attempts to resolve media without a configured access token", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called while unconfigured");
  });
  const [msg] = await client.extractIncomingMessages({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", messages: [{ from: "15551234567", id: "wamid.A", type: "image", image: { id: "media-1", caption: "FS watch" } }] },
          },
        ],
      },
    ],
  });
  assert.ok(msg, "the message itself must still come through");
  assert.equal(msg.text, "FS watch");
  assert.equal(msg.imageUrl, undefined, "no token configured means no media download is attempted, not a thrown error");
});
