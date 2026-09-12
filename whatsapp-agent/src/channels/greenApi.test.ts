import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.GREEN_API_INSTANCE_ID = "1234567890";
process.env.GREEN_API_API_TOKEN = "super-secret-green-api-token";

const client = require("./greenApi") as typeof import("./greenApi");

test("sendText posts to sendMessage with the individual @c.us chatId", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.green-api.com/waInstance1234567890/sendMessage/super-secret-green-api-token");
    const body = JSON.parse(init.body as string);
    assert.equal(body.chatId, "15551234567@c.us");
    assert.equal(body.message, "hello there");
    return new Response(JSON.stringify({ idMessage: "abc123" }), { status: 200 });
  });
  await client.sendText("+1 (555) 123-4567", "hello there");
});

test("sendText throws with the response status/body when the API rejects the send", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "bad request" }), { status: 400 }));
  await assert.rejects(() => client.sendText("15551234567", "hi"), /Green API sendMessage failed: 400/);
});

test("sendGroupText posts to sendMessage with the group @g.us chatId, never @c.us -- postings/groupPublishing.ts's WhatsApp-group branch depends on this staying distinct from sendText", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.chatId, "120363043968406745@g.us");
    assert.equal(body.message, "FS Rolex Daytona");
    return new Response(JSON.stringify({ idMessage: "def456" }), { status: 200 });
  });
  await client.sendGroupText("120363043968406745", "FS Rolex Daytona");
});

test("sendBannerImage sends a hosted link via sendFileByUrl, without uploading first", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    const body = JSON.parse(init.body as string);
    assert.equal(body.chatId, "15551234567@c.us");
    assert.equal(body.urlFile, "https://cdn.example/a.jpg");
    assert.equal(body.caption, "caption text");
    return new Response(JSON.stringify({ idMessage: "ghi789" }), { status: 200 });
  });
  await client.sendBannerImage("15551234567", "https://cdn.example/a.jpg", "caption text");
  assert.deepEqual(calls, ["https://api.green-api.com/waInstance1234567890/sendFileByUrl/super-secret-green-api-token"]);
});

test("sendBannerImage is a no-op for an empty imageUrl", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called for an empty imageUrl");
  });
  await client.sendBannerImage("15551234567", "");
});

test("sendBannerImage uploads a base64 data: URI via sendFileByUpload instead of sendFileByUrl", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ idMessage: "jkl012" }), { status: 200 });
  });
  await client.sendBannerImage("15551234567", "data:image/jpeg;base64,/9j/4AAQ==", "a caption");
  assert.deepEqual(calls, ["https://api.green-api.com/waInstance1234567890/sendFileByUpload/super-secret-green-api-token"]);
});

test("sendGroupBannerImage targets the group @g.us chatId", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.chatId, "120363043968406745@g.us");
    return new Response(JSON.stringify({ idMessage: "mno345" }), { status: 200 });
  });
  await client.sendGroupBannerImage("120363043968406745", "https://cdn.example/b.jpg");
});

function webhook(overrides: Partial<import("./greenApi").GreenApiWebhook> = {}): import("./greenApi").GreenApiWebhook {
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: "msg-1",
    senderData: { chatId: "15551234567@c.us", sender: "15551234567@c.us", senderName: "John" },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "buy: Rolex Daytona" } },
    ...overrides,
  };
}

test("extractIncomingMessages normalizes a plain 1:1 text message", () => {
  const [msg] = client.extractIncomingMessages(webhook());
  assert.ok(msg);
  assert.equal(msg.id, "msg-1");
  assert.equal(msg.phone, "15551234567");
  assert.equal(msg.text, "buy: Rolex Daytona");
  assert.equal(msg.isGroup, false);
  assert.equal(msg.senderName, "John");
});

test("extractIncomingMessages recognizes a group message, using the individual sender (not the group chatId) as phone", () => {
  const [msg] = client.extractIncomingMessages(
    webhook({
      senderData: { chatId: "120363043968406745@g.us", sender: "15559876543@c.us", senderName: "Jane the Dealer" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "FS Rolex Daytona 116500LN" } },
    })
  );
  assert.ok(msg);
  assert.equal(msg.isGroup, true);
  assert.equal(msg.groupId, "120363043968406745");
  assert.equal(msg.phone, "15559876543", "the poster's own identity, not the group's");
  assert.equal(msg.senderName, "Jane the Dealer");
});

test("extractIncomingMessages falls back to extendedTextMessageData.text when textMessageData is absent", () => {
  const [msg] = client.extractIncomingMessages(
    webhook({ messageData: { typeMessage: "extendedTextMessage", extendedTextMessageData: { text: "selling: Hermes Birkin" } } })
  );
  assert.equal(msg.text, "selling: Hermes Birkin");
});

test("extractIncomingMessages captures an image's downloadUrl directly as imageUrl -- no separate media-resolution round trip needed, unlike the Cloud API", () => {
  const [msg] = client.extractIncomingMessages(
    webhook({
      messageData: {
        typeMessage: "imageMessage",
        fileMessageData: { downloadUrl: "https://api.green-api.com/waInstance1/file/abc.jpg", caption: "FS Rolex", mimeType: "image/jpeg" },
      },
    })
  );
  assert.ok(msg);
  assert.equal(msg.imageUrl, "https://api.green-api.com/waInstance1/file/abc.jpg");
  assert.equal(msg.text, "FS Rolex", "a caption is used as text same as every other provider");
});

test("extractIncomingMessages does not drop a content-less document -- the active flow's own fallback must still get a chance to respond", () => {
  const [msg] = client.extractIncomingMessages(webhook({ messageData: { typeMessage: "documentMessage" } }));
  assert.ok(msg, "a document must still produce a message");
  assert.equal(msg.text, "");
  assert.equal(msg.imageUrl, undefined);
});

test("extractIncomingMessages drops a bare reaction -- a gesture is not an attempt to communicate anything", () => {
  const messages = client.extractIncomingMessages(webhook({ messageData: { typeMessage: "reactionMessage" } }));
  assert.equal(messages.length, 0);
});

test("extractIncomingMessages extracts a shared location pin, with no text needed to keep the message", () => {
  const [msg] = client.extractIncomingMessages(
    webhook({
      messageData: { typeMessage: "locationMessage", locationMessageData: { latitude: 25.7617, longitude: -80.1918 } },
    })
  );
  assert.ok(msg);
  assert.deepEqual(msg.location, { latitude: 25.7617, longitude: -80.1918 });
});

test("extractIncomingMessages produces nothing for a non-message webhook type (e.g. outgoingMessageStatus, a delivery/read receipt on Fi's own send)", () => {
  assert.deepEqual(client.extractIncomingMessages({ typeWebhook: "outgoingMessageStatus" }), []);
});

test("extractIncomingMessages produces nothing for a webhook with no typeWebhook at all", () => {
  assert.deepEqual(client.extractIncomingMessages({}), []);
});

test("listGreenApiGroups: gets getContacts and returns only the group entries, keyed by digits-only id", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://api.green-api.com/waInstance1234567890/getContacts/super-secret-green-api-token");
    assert.equal(init?.method, "GET");
    return new Response(
      JSON.stringify([
        { id: "15551234567@c.us", name: "Some Person" },
        { id: "120363043968406745@g.us", name: "Dealer Group One" },
        { id: "120363099999999999@g.us", name: "Dealer Group Two" },
      ]),
      { status: 200 }
    );
  });
  const groups = await client.listGreenApiGroups();
  assert.deepEqual(
    groups.map((g) => ({ groupId: g.groupId, name: g.name })),
    [
      { groupId: "120363043968406745", name: "Dealer Group One" },
      { groupId: "120363099999999999", name: "Dealer Group Two" },
    ]
  );
});

test("listGreenApiGroups: tolerates a {contacts:[...]} envelope instead of a bare array", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ contacts: [{ id: "120363011111111111@g.us", name: "Wrapped Group" }] }), { status: 200 }));
  const groups = await client.listGreenApiGroups();
  assert.deepEqual(groups.map((g) => g.groupId), ["120363011111111111"]);
});

test("listGreenApiGroups: skips a group-shaped entry with no recognizable id rather than throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{ name: "No id at all" }, { id: "120363022222222222@g.us", name: "Good Group" }]), { status: 200 }));
  const groups = await client.listGreenApiGroups();
  assert.deepEqual(groups.map((g) => g.groupId), ["120363022222222222"]);
});

test("listGreenApiGroups: throws with the response status/body when the API rejects the call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "bad request" }), { status: 400 }));
  await assert.rejects(() => client.listGreenApiGroups(), /Green API GET getContacts failed: 400/);
});
