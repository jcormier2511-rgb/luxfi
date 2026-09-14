import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "super-secret-cloud-token";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "1234567890";

const client = require("./whatsappCloud") as typeof import("./whatsappCloud");

test("sendText posts a text message to /{phoneNumberId}/messages with Bearer auth", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://graph.facebook.com/v21.0/1234567890/messages");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer super-secret-cloud-token");
    const body = JSON.parse(init.body as string);
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.to, "15551234567");
    assert.equal(body.type, "text");
    assert.equal(body.text.body, "hello there");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  });
  await client.sendText("+1 (555) 123-4567", "hello there");
});

test("sendText throws with the response status/body when the API rejects the send", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }));
  await assert.rejects(() => client.sendText("15551234567", "hi"), /WhatsApp Cloud API \/messages failed: 400/);
});

test("sendTemplate builds the documented template payload shape", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.type, "template");
    assert.deepEqual(body.template, {
      name: "fi_is_back",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Hi John" }, { type: "text", text: "+13055551212" }] }],
    });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 });
  });
  await client.sendTemplate("15551234567", "fi_is_back", "en_US", ["Hi John", "+13055551212"], "fallback text");
});

test("sendBannerImage sends a hosted link directly, without uploading media first", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.image, { link: "https://cdn.example/a.jpg", caption: "caption text" });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.3" }] }), { status: 200 });
  });
  await client.sendBannerImage("15551234567", "https://cdn.example/a.jpg", "caption text");
  assert.deepEqual(calls, ["https://graph.facebook.com/v21.0/1234567890/messages"]);
});

test("sendBannerImage is a no-op for an empty imageUrl", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called for an empty imageUrl");
  });
  await client.sendBannerImage("15551234567", "");
});

/**
 * The Cloud API's /messages endpoint only ever accepts an image by reference (a hosted link or a
 * previously-uploaded media id) -- it never accepts inline base64. A received image is now stored
 * as a base64 data: URI (mirroring whapi/client.ts's own `preview` handling), so re-sending one
 * (e.g. forwarding a seller's own sell-intake photo to a matched buyer) must upload it first via
 * POST /{phoneNumberId}/media, then send using the id that upload returns -- not the raw string.
 */
test("sendBannerImage uploads a base64 data: URI to /media first, then sends by id", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/media")) return new Response(JSON.stringify({ id: "media-abc123" }), { status: 200 });
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.image, { id: "media-abc123", caption: "" });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.4" }] }), { status: 200 });
  });
  await client.sendBannerImage("15551234567", "data:image/jpeg;base64,/9j/4AAQ==");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/1234567890/media");
  assert.equal(calls[1].url, "https://graph.facebook.com/v21.0/1234567890/messages");
});

function webhook(messages: any[], contacts: any[] = [], field = "messages"): any {
  return { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field, value: { messaging_product: "whatsapp", contacts, messages } }] }] };
}

test("extractIncomingMessages normalizes a plain text message, unprefixed identity", async () => {
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.A", type: "text", text: { body: "buy: Rolex Daytona" } }])
  );
  assert.ok(msg);
  assert.equal(msg.id, "whatsappcloud:wamid.A");
  assert.equal(msg.phone, "15551234567");
  assert.equal(msg.text, "buy: Rolex Daytona");
  assert.equal(msg.isGroup, false, "the Cloud API has no group concept -- every message is 1:1");
});

test("extractIncomingMessages picks up the sender's profile name from the contacts array", async () => {
  const [msg] = await client.extractIncomingMessages(
    webhook(
      [{ from: "15551234567", id: "wamid.B", type: "text", text: { body: "hi" } }],
      [{ profile: { name: "Elite Time NYC" }, wa_id: "15551234567" }]
    )
  );
  assert.equal(msg.senderName, "Elite Time NYC");
});

test("extractIncomingMessages captures an image's caption as text even before media resolution runs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/x", mime_type: "image/jpeg" }), { status: 200 }));
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.C", type: "image", image: { id: "media-1", caption: "FS Rolex Daytona" } }])
  );
  assert.ok(msg);
  assert.equal(msg.text, "FS Rolex Daytona");
});

test("extractIncomingMessages resolves an image's media id to a base64 data: URI via the two-step Bearer-authenticated download", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url === "https://graph.facebook.com/v21.0/media-2") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer super-secret-cloud-token");
      return new Response(JSON.stringify({ url: "https://lookaside.fbsbx.com/signed/xyz", mime_type: "image/jpeg" }), { status: 200 });
    }
    if (url === "https://lookaside.fbsbx.com/signed/xyz") {
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer super-secret-cloud-token");
      return new Response(Buffer.from("fake-jpeg-bytes"), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.D", type: "image", image: { id: "media-2" } }])
  );
  assert.ok(msg);
  assert.equal(msg.imageUrl, `data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`);
});

test("extractIncomingMessages never throws when media resolution fails -- the message still comes through with no imageUrl", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.E", type: "image", image: { id: "media-3" } }])
  );
  assert.ok(msg);
  assert.equal(msg.imageUrl, undefined);
});

test("extractIncomingMessages extracts a shared location pin, with no text needed to keep the message", async () => {
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.F", type: "location", location: { latitude: 25.7617, longitude: -80.1918 } }])
  );
  assert.ok(msg);
  assert.deepEqual(msg.location, { latitude: 25.7617, longitude: -80.1918 });
  assert.equal(msg.text, "");
});

test("extractIncomingMessages does not drop a content-less document -- the active flow's own fallback must still get a chance to respond", async () => {
  const [msg] = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.G", type: "document", document: { id: "doc-1" } }])
  );
  assert.ok(msg, "a document must still produce a message so the active flow's own fallback can respond");
  assert.equal(msg.text, "");
  assert.equal(msg.imageUrl, undefined);
});

test("extractIncomingMessages drops a bare reaction -- a gesture is not an attempt to communicate anything", async () => {
  const messages = await client.extractIncomingMessages(
    webhook([{ from: "15551234567", id: "wamid.H", type: "reaction", reaction: { message_id: "wamid.A", emoji: "👍" } } as any])
  );
  assert.equal(messages.length, 0);
});

test("extractIncomingMessages produces nothing for a change that carries only delivery/read statuses", async () => {
  const body = { object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.A", status: "delivered" }] } }] }] };
  const messages = await client.extractIncomingMessages(body);
  assert.equal(messages.length, 0);
});

test("extractIncomingMessages returns [] for a webhook with no entry at all", async () => {
  assert.deepEqual(await client.extractIncomingMessages({}), []);
});
