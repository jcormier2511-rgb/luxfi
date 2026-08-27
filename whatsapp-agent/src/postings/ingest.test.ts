import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ingestAndMatch } = require("./ingest") as typeof import("./ingest");

after(() => db._closePoolForTests());

test("a brand-new posting with no matches yet gets a monitoring acknowledgment", async (t) => {
  await db._resetDbForTests();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  await ingestAndMatch({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "m1",
    senderIdentity: "15551234567",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, "15551234567");
  assert.match(sent[0].message, /monitoring this request/i);
});

test("a brand-new posting that immediately matches gets the match notification instead of the generic acknowledgment", async (t) => {
  await db._resetDbForTests();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  await ingestAndMatch({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "seller-1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  sent.length = 0; // only care about what happens on the WTB side below

  await ingestAndMatch({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "buyer-1",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  assert.ok(!sent.some((s) => /monitoring this request/i.test(s.message)), "no generic ack once a match was found");
  assert.ok(sent.some((s) => /Potential Match/.test(s.message)), "the buyer should get a match notification");
});

test("re-editing a message that still finds nothing does not re-send the acknowledgment", async (t) => {
  await db._resetDbForTests();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const input = {
    platform: "whatsapp",
    chatId: "g1",
    messageId: "m1",
    senderIdentity: "15551234567",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  };
  await ingestAndMatch(input);
  assert.equal(sent.length, 1);

  // Edit the message (still no FS counterpart exists) — must not re-send the acknowledgment.
  await ingestAndMatch({ ...input, text: "WTB Rolex Daytona 116500LN budget $32,000" });
  assert.equal(sent.length, 1, "only a brand-new posting with zero matches gets the acknowledgment");
});

test("text that doesn't classify as FS/WTB never sends anything", async (t) => {
  await db._resetDbForTests();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  await ingestAndMatch({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "m1",
    senderIdentity: "15551234567",
    text: "hey what's up",
  });

  assert.equal(sent.length, 0);
});
