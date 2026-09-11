import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "http";
import type { AddressInfo } from "net";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "green-api-webhook-test-token";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

const adminStore = require("./admin/store") as typeof import("./admin/store");
const { createServer } = require("./server") as typeof import("./server");
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
const postingsDb = require("./postings/db") as typeof import("./postings/db");
const { getState, resetState } = require("./conversation/stateStore") as typeof import("./conversation/stateStore");

let server: Server;
let baseUrl: string;

before(async () => {
  await adminStore.initAdminSchema();
  server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  await adminStore._closePoolForTests();
});

function webhook(chatId: string, sender: string, text: string, idMessage = `wm-${Math.random()}`) {
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage,
    senderData: { chatId, sender, senderName: "Test Dealer" },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: text } },
  };
}

test("POST /webhook/greenapi rejects a missing or wrong token", async () => {
  const noToken = await fetch(`${baseUrl}/webhook/greenapi`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhook("15550001111@c.us", "15550001111@c.us", "hi")),
  });
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(`${baseUrl}/webhook/greenapi?token=wrong`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhook("15550001111@c.us", "15550001111@c.us", "hi")),
  });
  assert.equal(wrongToken.status, 401);
});

test("POST /webhook/greenapi with a valid token processes a real 1:1 message through the normal conversation flow", async () => {
  const phone = "15559990101";
  resetState(phone);
  await fetch(`${baseUrl}/webhook/greenapi?token=green-api-webhook-test-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhook(`${phone}@c.us`, `${phone}@c.us`, "WTB Rolex Daytona 116500LN budget $30,000")),
  });
  // The route acks immediately then processes async -- give the event loop a turn.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(getState(phone).pendingBuyIntake, "the WTB message must have reached the normal conversation flow and opened a draft");
});

test("POST /webhook/greenapi ignores a non-message webhook type (e.g. outgoingMessageStatus) without error", async () => {
  const res = await fetch(`${baseUrl}/webhook/greenapi?token=green-api-webhook-test-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ typeWebhook: "outgoingMessageStatus", idMessage: "status-1" }),
  });
  assert.equal(res.status, 200);
});
