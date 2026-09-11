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
const whapiClient = require("./channels/greenApi") as typeof import("./channels/greenApi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsStore = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ingestModule = require("./postings/ingest") as typeof import("./postings/ingest");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("./server") as typeof import("./server");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("./postings/notify") as typeof import("./postings/notify");

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

  const result = await ingestDirectSellPosting({
    phone: sellerPhone,
    senderName: "Seller",
    description: "Rolex Submariner 116610LV",
    reference: "116610LV",
    price: 14500,
  });
  // ingestDirectSellPosting defers match-card notifications rather than sending them inline (see
  // FlowResult.pendingMatchNotifications) -- the real dispatch layer (server.ts) sends them once
  // this turn's own reply has gone out; a direct call here has to do that itself.
  for (const { matchId, revision } of result.pendingNotifications) await notify.notifyMatch(matchId, revision);

  const sellerMsg = sent.find((s) => s.phone === sellerPhone && /Match ID#/.test(s.message));
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

test('required regression: "You\'re connected!" never shows the counterpart\'s raw identity right next to the same number properly formatted -- real reported bug: "You\'re connected! telegram:5703391972: +1 (570) 339-1972"', () => {
  const noRealName = formatApprovalOutcome({ status: "approved", counterpart: { name: "telegram:5703391972", phone: "5703391972" } }, 781);
  assert.doesNotMatch(noRealName, /telegram:5703391972/, "the raw identity must never be shown when it's not an actual name");
  assert.match(noRealName, /You're connected! \+1 \(570\) 339-1972/);

  const realName = formatApprovalOutcome({ status: "approved", counterpart: { name: "John Smith", phone: "15551234567" } }, 782);
  assert.match(realName, /You're connected! John Smith: \+1 \(555\) 123-4567/, "an actual name is still shown, labeling the number");
});

test("required (privacy): approving a direct-posting match never shows the raw, unformatted counterpart phone number as an 'identity' -- only ever the properly formatted reveal", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const sellerPhone = "19990000006";
  const buyerPhone = "19990000007";
  const sent = mockSends(t);
  // No senderName given — contact_name falls back to the raw phone (see postingsStore.ts's
  // `senderName || senderIdentity`), the real reported bug: a first-time buyer with no captured
  // WhatsApp display name had their own phone number echoed straight back to them as an
  // "identity" in the seller's very first match card, before the buyer had ever agreed to
  // connect with anyone. Approving now reveals the counterpart immediately (no more waiting on
  // mutual confirmation) — this only ever checks that the reveal itself is the properly
  // formatted phone, never the raw digit string, an identity-filter property unrelated to that
  // timing change.
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "group-1",
    messageId: "wtb-privacy-1",
    senderIdentity: buyerPhone,
    text: "WTB Rolex Submariner 116610LV budget $16,000",
  });
  const result = await ingestDirectSellPosting({
    phone: sellerPhone,
    senderName: "Seller",
    description: "Rolex Submariner 116610LV",
    reference: "116610LV",
    price: 14500,
  });
  for (const { matchId, revision } of result.pendingNotifications) await notify.notifyMatch(matchId, revision);

  const sellerMsg = sent.find((s) => s.phone === sellerPhone && /Match ID#/.test(s.message));
  assert.ok(sellerMsg);
  assert.doesNotMatch(sellerMsg!.message, new RegExp(buyerPhone), "the initial match card must never leak the buyer's raw phone number");
  const matchId = Number(sellerMsg!.message.match(/approve (\d+)/)?.[1]);

  const reply = await tryHandleDirectPostingDecision(sellerPhone, `approve ${matchId}`);
  assert.ok(reply);
  assert.match(reply!, /connected/i, "approving now reveals the counterpart immediately, in this same reply");
  assert.doesNotMatch(reply!, new RegExp(buyerPhone), "the reveal itself must show the properly formatted phone, never the raw digit string");
});

test("tryHandleDirectPostingDecision falls through (returns null) for a phone with no direct-sourced posting on the match", async (t) => {
  assert.equal(config.postingsV4.enabled, false);
  await db._resetDbForTests();
  const { matchId } = await seedMatch(t, "19990000006");

  const reply = await tryHandleDirectPostingDecision("19990000001", `approve ${matchId}`); // the chat-sourced WTB buyer, not the direct seller
  assert.equal(reply, null, "must not resolve a decision for a non-direct-sourced side of the match");
});
