import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// A person's own "sell a watch" conversational intake (conversation/flow.ts) creates a real,
// always-active 'direct'-sourced FS posting and matches it against live WTB postings
// immediately — see postings/ingest.ts's ingestDirectSellPosting and server.ts's
// tryHandleDirectPostingDecision. Unlike the group-chat monitoring surface (postings/, gated
// behind ENABLE_V4_POSTINGS for controlled rollout), this is a narrower, explicit-consent
// feature that must keep working with that flag off — proven here by leaving it unset.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-server-directposting-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// ENABLE_V4_POSTINGS intentionally left unset — the whole point of this file.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("./config") as typeof import("./config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("./whapi/client") as typeof import("./whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsStore = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ingestModule = require("./postings/ingest") as typeof import("./postings/ingest");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("./server") as typeof import("./server");

const { ingestChatPosting } = postingsStore;
const { ingestDirectSellPosting } = ingestModule;
const { tryHandleDirectPostingDecision, tryHandleV4Decision, formatApprovalOutcome } = server;

after(async () => {
  await db._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function mockSends(t: TestContext): { phone: string; message: string }[] {
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });
  return sent;
}

async function seedMatch(t: TestContext, sellerPhone: string) {
  const sent = mockSends(t);
  // ingestChatPosting itself carries no ENABLE_V4_POSTINGS gate (only group-message ingestion
  // via conversation/groupMonitor.ts does) — a live WTB posting can exist regardless of the flag.
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "group-1",
    messageId: "wtb-1",
    senderIdentity: "19990000001",
    senderName: "Buyer",
    text: "WTB Rolex Submariner 116610LV budget $16,000",
  });

  await ingestDirectSellPosting({
    phone: sellerPhone,
    senderName: "Seller",
    description: "Rolex Submariner 116610LV",
    reference: "116610LV",
    price: 14500,
  });

  const sellerMsg = sent.find((s) => s.phone === sellerPhone && /Potential Match/.test(s.message));
  assert.ok(sellerMsg, "the direct-posting seller must be notified even with ENABLE_V4_POSTINGS unset");
  const matchId = Number(sellerMsg!.message.match(/approve (\d+)/)?.[1]);
  assert.ok(Number.isInteger(matchId), "the match message must carry a numeric match id");
  return { matchId, sent };
}

test("required: a direct-sourced posting matches a live WTB request and notifies the seller with ENABLE_V4_POSTINGS unset", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  await seedMatch(t, "19990000002");
});

test("required: the seller can approve a direct-posting match via tryHandleDirectPostingDecision with ENABLE_V4_POSTINGS unset", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const sellerPhone = "19990000003";
  const { matchId } = await seedMatch(t, sellerPhone);

  // Ordinary conversation is allowed between presentation and decision. It must not clear the
  // durable match_recipient row or make the exact ID Fi just displayed unactionable.
  await server.processIncomingMessages([{ id: "intervening-chat", phone: sellerPhone, text: "thanks", isGroup: false }]);

  const reply = await tryHandleDirectPostingDecision(sellerPhone, `approve ${matchId}`);
  assert.ok(reply, "must produce a reply for the seller's own direct-posting match");
  assert.match(reply!, /connected|as soon as the other side confirms/i);
});

test("required: the seller can pass on a direct-posting match via tryHandleDirectPostingDecision with ENABLE_V4_POSTINGS unset", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const sellerPhone = "19990000004";
  const { matchId } = await seedMatch(t, sellerPhone);

  const reply = await tryHandleDirectPostingDecision(sellerPhone, `pass ${matchId}`);
  assert.equal(reply, `Passing on match ${matchId}.`);
});

test("tryHandleV4Decision (the group-chat monitoring surface) stays a no-op for the exact same direct-posting match while the flag is off", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const sellerPhone = "19990000005";
  const { matchId } = await seedMatch(t, sellerPhone);

  const reply = await tryHandleV4Decision(sellerPhone, `approve ${matchId}`);
  assert.equal(reply, null, "the flag-gated v4 surface must remain untouched by the direct-posting feature");
});

test("required: formatApprovalOutcome suggests escrow/inspection partners on a real connection reveal, never on any other outcome", () => {
  const suggestion = /escrow and inspection partners/i;

  assert.match(formatApprovalOutcome({ status: "approved", counterpart: { name: "Alex", phone: "111" } }, 1), suggestion);
  assert.doesNotMatch(
    formatApprovalOutcome({ status: "approved" }, 1),
    suggestion,
    "no counterpart contact means nothing was actually revealed — no escrow suggestion to attach it to"
  );
  assert.doesNotMatch(formatApprovalOutcome({ status: "pending_confirmation" }, 1), suggestion, "nothing revealed yet");
  assert.doesNotMatch(formatApprovalOutcome({ status: "posting_closed" }, 1), suggestion);
  assert.doesNotMatch(formatApprovalOutcome({ status: "invalid" }, 1), suggestion);
  assert.doesNotMatch(formatApprovalOutcome({ status: "locked", lockReason: "no_plan" }, 1), suggestion);
});

test("approval replies identify the exact presented match and its available details", () => {
  const reply = formatApprovalOutcome({
    status: "pending_confirmation",
    match: { identity: "ABC Watches", brand: "Rolex", model: "Daytona", reference: "116500LN", dial: "Black", price: "28500", currency: "USD", location: "Miami, USA" },
  }, 413);
  assert.match(reply, /Approved Match 413/);
  assert.match(reply, /ABC Watches/);
  assert.match(reply, /Rolex Daytona 116500LN/);
  assert.match(reply, /Dial\/Color: Black/);
  assert.match(reply, /\$28,500/);
  assert.match(reply, /Miami, USA/);
});

test("tryHandleDirectPostingDecision falls through (returns null) for a phone with no direct-sourced posting on the match", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const { matchId } = await seedMatch(t, "19990000006");

  const reply = await tryHandleDirectPostingDecision("19990000001", `approve ${matchId}`); // the chat-sourced WTB buyer, not the direct seller
  assert.equal(reply, null, "must not resolve a decision for a non-direct-sourced side of the match");
});
