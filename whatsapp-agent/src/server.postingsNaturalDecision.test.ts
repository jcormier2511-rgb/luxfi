import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Live-reported: replying "Yes, connect me with the seller" (or naming the seller) to a
 * "Potential Match ... approve/pass <id>" card did nothing — only the literal "approve <id>"/
 * "pass <id>" format was ever recognized for the postings-based match system. A natural-language
 * fallback already existed for the OLDER, in-session numbered-match-list flow (conversation/
 * flow.ts's interpretDecision), but nothing equivalent covered these match cards at all.
 *
 * This file proves the new fallback (server.ts's tryInterpretPostingsDecisionNaturally, feeding
 * ai/decisionInterpreter.ts's interpretPostingsDecision) end to end: gated behind the same
 * AI-matching test-phone allowlist the v3 fallback already uses, never invented for anyone else,
 * and never able to approve/reveal anything the deterministic "approve <id>" path couldn't.
 */
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-server-postings-natural-decision-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const TEST_PHONE = "19993330001";
process.env.AI_MATCHING_TEST_PHONE = TEST_PHONE;
// ENABLE_V4_POSTINGS intentionally left unset — the direct-posting decision path this mostly
// exercises must keep working regardless (see server.directPostingDecision.test.ts).

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("./postings/notify") as typeof import("./postings/notify");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const decisionInterpreter = require("./ai/decisionInterpreter") as typeof import("./ai/decisionInterpreter");

const { ingestChatPosting } = postingsStore;
const { ingestDirectSellPosting } = ingestModule;
const { tryHandleDirectPostingDecision } = server;

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

let counter = 0;
/** A live WTB (chat-sourced) matched against a fresh 'direct'-sourced FS posting from
 *  `sellerPhone` — mirrors server.directPostingDecision.test.ts's own seedMatch, but also
 *  flushes the deferred match-card notification (see FlowResult.pendingMatchNotifications /
 *  postings/ingest.ts) since this calls ingestDirectSellPosting directly, bypassing the real
 *  dispatch layer that would otherwise send it. */
async function seedMatch(t: TestContext, sellerPhone: string): Promise<{ matchId: number; sent: { phone: string; message: string }[] }> {
  const n = ++counter;
  const sent = mockSends(t);
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "group-1",
    messageId: `wtb-${n}`,
    senderIdentity: `buyer-${n}`,
    senderName: "Buyer",
    text: `WTB Rolex Submariner ${116610 + n}LV budget $16,000`,
  });
  const result = await ingestDirectSellPosting({
    phone: sellerPhone,
    senderName: "Seller",
    description: `Rolex Submariner ${116610 + n}LV`,
    reference: `${116610 + n}LV`,
    price: 14500,
  });
  for (const { matchId, revision } of result.pendingNotifications) await notify.notifyMatch(matchId, revision);

  const sellerMsg = sent.find((s) => s.phone === sellerPhone && /Potential Match/.test(s.message));
  assert.ok(sellerMsg, "precondition: the seller must actually be notified of a pending match");
  const matchId = Number(sellerMsg!.message.match(/approve (\d+)/)?.[1]);
  assert.ok(Number.isInteger(matchId), "precondition: the match message must carry a numeric match id");
  return { matchId, sent };
}

test("required: a natural-language reply approves the seller's only pending match, for the AI-matching test phone", async (t) => {
  await db._resetDbForTests();
  t.mock.method(decisionInterpreter, "interpretPostingsDecision", async () => ({ action: "approve", matchId: null }));

  const { matchId } = await seedMatch(t, TEST_PHONE);
  const natural = await tryHandleDirectPostingDecision(TEST_PHONE, "Yes, connect me with the seller");
  assert.ok(natural, "must produce a reply, not fall through");
  assert.match(natural!, /as soon as the other side confirms/i, "only one side has decided so far -- pending mutual confirmation, same as the deterministic path");

  // Re-approving via the deterministic "approve <id>" format is idempotent (same code path,
  // approveMatch itself) and must produce the exact same outcome the natural-language reply did.
  const deterministic = await tryHandleDirectPostingDecision(TEST_PHONE, `approve ${matchId}`);
  assert.equal(deterministic, natural);
});

test("required: natural language names a specific counterpart, resolving to THAT match rather than defaulting to the latest", async (t) => {
  await db._resetDbForTests();
  const { matchId: firstMatchId } = await seedMatch(t, TEST_PHONE);
  const { matchId: secondMatchId } = await seedMatch(t, TEST_PHONE);
  assert.notEqual(firstMatchId, secondMatchId);

  const spy = t.mock.method(decisionInterpreter, "interpretPostingsDecision", async () => ({ action: "pass", matchId: firstMatchId }));
  const reply = await tryHandleDirectPostingDecision(TEST_PHONE, "pass on the first one");
  assert.equal(reply, `Passing on match ${firstMatchId}.`);
  assert.equal(spy.mock.callCount(), 1);

  // The OTHER match must be completely untouched.
  const stillPending = await tryHandleDirectPostingDecision(TEST_PHONE, `pass ${secondMatchId}`);
  assert.equal(stillPending, `Passing on match ${secondMatchId}.`, "the second match must still have been pending, not already decided");
});

test("required (safety): natural-language decisions are inert for a phone NOT on the AI-matching test-phone allowlist, even with a real pending match", async (t) => {
  await db._resetDbForTests();
  const spy = t.mock.method(decisionInterpreter, "interpretPostingsDecision", async () => {
    throw new Error("must never be called for a phone off the allowlist");
  });
  const otherPhone = "19993330099";
  await seedMatch(t, otherPhone);

  const reply = await tryHandleDirectPostingDecision(otherPhone, "yes, connect me with the seller");
  assert.equal(reply, null, "must fall through rather than approve/pass anything for a non-test phone");
  assert.equal(spy.mock.callCount(), 0);
});

test("a message that isn't actually a decision (interpretPostingsDecision returns action:null) falls through, leaving the match untouched", async (t) => {
  await db._resetDbForTests();
  t.mock.method(decisionInterpreter, "interpretPostingsDecision", async () => ({ action: null, matchId: null }));
  const { matchId } = await seedMatch(t, TEST_PHONE);

  const reply = await tryHandleDirectPostingDecision(TEST_PHONE, "how's the weather");
  assert.equal(reply, null);

  const stillPending = await tryHandleDirectPostingDecision(TEST_PHONE, `approve ${matchId}`);
  assert.match(stillPending!, /connected|as soon as the other side confirms/i, "the match must still be pending — untouched by the non-decision message");
});
