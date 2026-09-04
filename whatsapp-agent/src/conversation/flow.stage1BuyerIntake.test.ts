import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * STAGE 1 LAUNCH BLOCKER — live Telegram buyer test.
 *
 * One natural sentence describing ONE watch was answered with "I'll start with the first one —
 * send me the others one at a time", then "Any location preference?" — although the sentence
 * named the location. Two faults compounded: the message was split at the word "and" and
 * "don't WANT to spend" read as a second buy request, so one watch became two; and the location
 * parser only knew eight regions, none of them Miami.
 *
 * The contract this file pins: a message is one item unless a second segment names a product of
 * its own; every slot the message supplies is read in one pass; nothing already supplied is
 * asked again; Telegram and WhatsApp produce the same structured request for the same text.
 */
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-stage1-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.WHAPI_TOKEN = "";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";

const db = require("../postings/db") as typeof import("../postings/db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const { handleIncomingMessage, parseItemRequests } = require("./flow") as typeof import("./flow");
const { resetState, getState } = require("./stateStore") as typeof import("./stateStore");
const { getActivePostingsForUser, createDirectPosting } = require("../postings/postingsStore") as typeof import("../postings/postingsStore");
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
const { platformForIdentity } = require("../channels/identity") as typeof import("../channels/identity");
const server = require("../server") as typeof import("../server");
const whapi = require("../whapi/client") as typeof import("../whapi/client");
const telegram = require("../channels/telegram") as typeof import("../channels/telegram");

before(async () => { await db._resetDbForTests(); await inventory._resetDbForTests(); });
after(async () => {
  await db._closePoolForTests(); await inventory._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

/** The exact sentence from the failed live test. Do not paraphrase it here. */
const LIVE_SENTENCE = "I'm looking for a pre-owned Rolex Daytona 116500LN with a black dial. I'm in Miami and don't want to spend more than $25,000.";
const EXPECTED = { brand: "rolex", model: "Daytona", reference: "116500LN", dialColor: "black", condition: "pre-owned", budget: 25000, currency: "USD", location: "Miami" };

let counter = 0;
const fresh = (prefix = "telegram:5551") => `${prefix}${String(++counter).padStart(6, "0")}`;
const structured = (identity: string) => {
  const d = getState(identity).pendingBuyIntake;
  return d && { brand: d.brand, model: d.model, reference: d.reference, dialColor: d.dialColor, condition: d.condition, budget: d.budget, currency: d.currency, location: d.location, step: d.step };
};

test("REQUIRED: the exact live sentence becomes ONE complete WTB draft and goes straight to confirmation", async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  const reply = await handleIncomingMessage(identity, LIVE_SENTENCE);
  const text = reply.messages.join("\n");

  // 1–2. One item; no multi-item prompt.
  assert.equal(parseItemRequests(LIVE_SENTENCE).length, 1, "exactly one WTB intake");
  assert.doesNotMatch(text, /start with the first one/i, "no multi-item prompt");
  assert.ok(getState(identity).pendingBuyIntake, "a draft exists");
  assert.equal(getState(identity).pendingSellIntake, undefined);

  // 3–10. Every slot, from one pass.
  assert.deepEqual(structured(identity), { ...EXPECTED, step: "confirm" });

  // 11–12. Nothing already supplied is asked again; review/confirmation is next.
  assert.doesNotMatch(text, /location preference/i, "Fi must not ask for the location it was given");
  assert.doesNotMatch(text, /what condition|maximum budget|which model|black dial, white dial/i, "no follow-up for a supplied field");
  assert.match(text, /Should I start monitoring\?/);
  assert.match(text, /^I have:\nWTB — Rolex Daytona 116500LN\nBlack dial\nPre-owned\nMaximum: \$25,000\nLocation: Miami\nPhoto: none\n\nShould I start monitoring\?\nReply CONFIRM to start monitoring, or send a correction\.$/m,
    "the review states each fact once, names the watch rather than echoing the sentence, and asks once");
  assert.doesNotMatch(text, /listing review|Not provided/);

  // 13. Nothing is live until the customer confirms.
  const userId = await getOrCreateCanonicalUser(platformForIdentity(identity), identity);
  assert.deepEqual(await getActivePostingsForUser(userId), [], "no active listing before confirmation");

  const confirmed = await handleIncomingMessage(identity, "confirm");
  assert.match(confirmed.messages.join("\n"), /active|monitoring/i);
  // 14. The activation card itself tells the customer what happens next — in the SAME message
  // (one card on both channels), naming only commands that exist.
  assert.match(confirmed.messages[0], /Your WTB request is active:[\s\S]*What happens next:\n• I’ll message you here the moment a matching listing appears, with an approve \/ pass choice\.\n• Reply "listings" any time to review this request, or "cancel" to stop monitoring\.\n• Reply "help" for everything else I can do\.$/);
  const active = await getActivePostingsForUser(userId);
  assert.equal(active.length, 1, "confirmation activates exactly one request");
  assert.equal(active[0].reference, "116500LN");
  assert.equal(active[0].location, "Miami");
});

/** 14. Telegram and WhatsApp share the canonical intake: the same text, the same draft. */
test("REQUIRED: Telegram and WhatsApp inbound produce equivalent structured intake for the live sentence", async (t) => {
  t.mock.method(whapi, "sendText", async () => {});
  t.mock.method(telegram, "sendText", async () => {});
  const chatId = "777000001";
  const phone = "15550777001";
  resetState(`telegram:${chatId}`); resetState(phone);

  await server.processIncomingMessages(await telegram.extractIncomingMessages({
    update_id: 1, message: { message_id: 1, from: { id: Number(chatId), first_name: "John" }, chat: { id: Number(chatId), type: "private" }, text: LIVE_SENTENCE },
  } as never));
  await server.handleWebhookPayload({
    messages: [{ id: "wa-1", from_me: false, type: "text", chat_id: `${phone}@s.whatsapp.net`, from: `${phone}@s.whatsapp.net`, text: { body: LIVE_SENTENCE } }],
  } as never);

  const viaTelegram = structured(`telegram:${chatId}`);
  const viaWhatsApp = structured(phone);
  assert.ok(viaTelegram && viaWhatsApp, "both channels reached the conversation layer");
  assert.deepEqual(viaTelegram, { ...EXPECTED, step: "confirm" });
  assert.deepEqual(viaWhatsApp, viaTelegram, "channel parity: identical structured intake");
});

const PARAPHRASES: ReadonlyArray<[string, Partial<typeof EXPECTED>]> = [
  ["Need a black 116500LN, used, max 25k, Miami.",                                          { ...EXPECTED, condition: "used" }],
  ["Looking for Rolex 116500LN black dial around $25k. Located in Miami.",                  { brand: "rolex", model: "Daytona", reference: "116500LN", dialColor: "black", budget: 25000, currency: "USD", location: "Miami" }],
  ["I need a Daytona 116500LN. Black dial. Preowned. I'm in Florida. Budget is $25,000 max.", { ...EXPECTED, location: "Florida" }],
  ["Buy Rolex Daytona 116500LN black, pre-owned, Miami, up to $25k.",                        EXPECTED],
  ["WTB 116500LN black dial used max 25k Miami",                                            { ...EXPECTED, condition: "used" }],
  ["I'm looking for a Rolex 116500LN, black dial, pre-owned, in Miami, no more than $25,000", EXPECTED],
];
for (const [message, expected] of PARAPHRASES) {
  test(`paraphrase resolves to one WTB with equivalent fields: "${message.slice(0, 60)}"`, async () => {
    const identity = fresh();
    resetState(identity);
    const reply = await handleIncomingMessage(identity, message);
    assert.equal(parseItemRequests(message).length, 1, "one item");
    assert.doesNotMatch(reply.messages.join("\n"), /start with the first one/i);
    const draft = getState(identity).pendingBuyIntake;
    assert.ok(draft, "a WTB draft");
    for (const [field, value] of Object.entries(expected)) {
      assert.equal((draft as unknown as Record<string, unknown>)[field], value, `${field} for "${message}"`);
    }
    if (expected.condition) assert.equal(draft.step, "confirm", "every required field supplied → straight to confirmation");
    else assert.equal(draft.step, "condition", "the ONE field the message really left out is the one asked for");
  });
}

test("$25,000 and $25k both read as 25000, and a reference is never mistaken for a price", () => {
  for (const [message, budget] of [["WTB 116500LN max $25,000", 25000], ["WTB 116500LN max $25k", 25000], ["WTB 116500LN up to 25k", 25000], ["WTB 116500LN budget 116500", 116500]] as const) {
    const identity = fresh(); resetState(identity);
    return handleIncomingMessage(identity, message).then(() => {
      const d = getState(identity).pendingBuyIntake!;
      assert.equal(d.budget, budget, message);
      assert.equal(d.reference, "116500LN", message);
    });
  }
});

test("multi-item handling only when a SECOND product is actually named", () => {
  const multiple = [
    ["I'm looking for a Rolex 116500LN and a Patek 5712G.", 2],
    ["Need these three: 116500LN, 126710BLRO, 5712G.", 3],
  ] as const;
  const single = [
    LIVE_SENTENCE,
    "Rolex Daytona 116500LN, black dial, pre-owned, Miami, max $25k.",
    "WTB Rolex 116500LN, black dial, and I'm in Miami, and my budget is $25,000",
    "Looking for a 116500LN black dial and pre-owned, Miami, up to 25k",
  ];
  for (const [text, count] of multiple) assert.equal(parseItemRequests(text).length, count, text);
  for (const text of single) assert.ok(parseItemRequests(text).length <= 1, `must not be multiple: "${text}"`);
});

test("old listings and an unfinished draft do not contaminate a new complete request", async () => {
  const identity = fresh();
  resetState(identity);
  // Historical, unrelated, still-active listings on the same account.
  await createDirectPosting({ phone: identity, type: "WTB", description: "WTB Patek 5712G", brand: "Patek", reference: "5712G", price: 90000 });
  await createDirectPosting({ phone: identity, type: "FS", description: "FS Omega Speedmaster", brand: "Omega", reference: "311.30.42.30.01.005", price: 6000 });
  // An unfinished prior draft, abandoned at the budget question.
  await handleIncomingMessage(identity, "wtb rolex");
  assert.equal(getState(identity).pendingBuyIntake?.step, "budget", "precondition: an open, incomplete draft");

  const reply = await handleIncomingMessage(identity, LIVE_SENTENCE);
  const text = reply.messages.join("\n");
  assert.doesNotMatch(text, /start with the first one/i, "not read as multiple items");
  assert.doesNotMatch(text, /kept your request draft open|What's your maximum budget/i, "not swallowed as an answer to the stale draft's budget question");
  const draft = structured(identity);
  assert.ok(draft, "a draft for the NEW request exists");
  for (const [field, value] of Object.entries(EXPECTED)) assert.equal((draft as unknown as Record<string, unknown>)[field], value, field);
  assert.equal(draft!.step, "confirm");
});
