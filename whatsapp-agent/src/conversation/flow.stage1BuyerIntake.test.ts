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
const { resetState, getState, _resetContentDedupeForTests, _resetPhantomCompanionForTests } = require("./stateStore") as typeof import("./stateStore");
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

test('required regression: a one-character typo on "confirm" ("confirrm") still activates the request — Fi explicitly asks the customer to reply with that exact word', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, LIVE_SENTENCE);
  assert.equal(getState(identity).pendingBuyIntake?.step, "confirm");

  const typoed = await handleIncomingMessage(identity, "confirrm");
  assert.match(typoed.messages.join("\n"), /active|monitoring/i, "a near-miss typo of the exact requested word must not read as an unrecognized reply");
  const userId = await getOrCreateCanonicalUser(platformForIdentity(identity), identity);
  assert.equal((await getActivePostingsForUser(userId)).length, 1);
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
    // Condition is never its own asked step -- it defaults silently to "pre-owned" when the
    // message didn't state one, so every other field being present always goes straight to
    // confirmation.
    assert.equal(draft.condition, expected.condition ?? "pre-owned", `condition for "${message}"`);
    assert.equal(draft.step, "confirm", "every required field supplied → straight to confirmation");
  });
}

test('required: "BNIB" is recognized as New condition, not defaulted to pre-owned', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  const reply = await handleIncomingMessage(identity, "WTB Rolex Daytona 116500LN black dial BNIB in Miami max $25,000");
  assert.doesNotMatch(reply.messages.join("\n"), /start with the first one/i);
  const draft = getState(identity).pendingBuyIntake;
  assert.ok(draft, "a WTB draft");
  assert.equal(draft!.condition, "New", 'BNIB must be recognized as "New", not left to default to pre-owned');
  assert.equal(draft!.step, "confirm", "every required field supplied → straight to confirmation");
  assert.doesNotMatch(reply.messages.join("\n"), /\bBNIB\b/, "BNIB must not leak into the model as unrecognized text");
});

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

/**
 * Real reported bug: a single "Hi, I want to join LuxFi network" produced THREE replies —
 * "What would you like to buy? Please include the brand and model." (a fresh buy-intake draft
 * opened), then "I kept your request draft open." followed by the very same question again. The
 * message-id dedup (alreadyProcessed) never caught it because the two deliveries carried
 * DIFFERENT ids for what was, to the sender, one message (a WhatsApp multi-device echo / a
 * provider retry with a new id) -- so the whole pipeline ran twice: the first pass created the
 * draft and asked the question, the second pass then answered that just-created, still-empty
 * draft with "kept your request draft open" plus the same question again.
 */
test("required regression: a duplicate delivery of the same message under a DIFFERENT id is processed once, not twice", async (t) => {
  const sendTextSpy = t.mock.method(whapi, "sendText", async () => {});
  _resetContentDedupeForTests();
  const phone = fresh("15550779").replace(/[^\d]/g, "");
  resetState(phone);

  // No brand/reference named -- the exact shape of the live message ("Hi, I want to join LuxFi
  // network") that opened a brand-new, still-empty buy-intake draft and asked its first question.
  const text = "I need help, can you assist";
  await server.processIncomingMessages([{ id: "dup-a", phone, text, isGroup: false }]);
  const repliesFromFirstDelivery = sendTextSpy.mock.callCount();
  assert.ok(repliesFromFirstDelivery > 0, "the first, real delivery gets at least one reply");
  assert.ok(getState(phone).pendingBuyIntake, "precondition: it opened a fresh buy-intake draft");

  // Same phone, same text, a DIFFERENT id -- exactly what alreadyProcessed(id) cannot catch (a
  // WhatsApp multi-device echo / provider retry delivers the SAME real message under a new id).
  await server.processIncomingMessages([{ id: "dup-b", phone, text, isGroup: false }]);
  assert.equal(sendTextSpy.mock.callCount(), repliesFromFirstDelivery,
    "the duplicate delivery must add ZERO further replies -- without this fix it answered the just-created draft a second time (\"I kept your request draft open.\" plus the same question again)");
});

/**
 * Real reported bug (live, recurring, not yet fully root-caused): a single COMPLETE request
 * ("I'm looking for a pre-owned Rolex Daytona 116500LN with a black dial. I'm in Miami and don't
 * want to spend more than $25,000.") produced the correct "I have: WTB ..." confirmation summary,
 * then a spurious "I kept your request draft open.", then the SAME summary again -- three
 * replies to one message, confirmed via production [whapi] raw logs to be a content-less
 * companion delivered under a different id, same instant, immediately after every real message.
 */
test("required regression: a content-less companion delivered right after a real, complete request adds zero further replies", async (t) => {
  const sendTextSpy = t.mock.method(whapi, "sendText", async () => {});
  _resetContentDedupeForTests();
  _resetPhantomCompanionForTests();
  const phone = fresh("15550780").replace(/[^\d]/g, "");
  resetState(phone);

  await server.processIncomingMessages([{ id: "real-1", phone, text: LIVE_SENTENCE, isGroup: false }]);
  const repliesFromRealMessage = sendTextSpy.mock.callCount();
  assert.ok(repliesFromRealMessage > 0, "the real, complete request gets at least one reply");
  assert.equal(getState(phone).pendingBuyIntake?.step, "confirm", "precondition: the complete request went straight to confirmation");

  // Same phone, arriving right after, a DIFFERENT id, no text and no image -- exactly the
  // observed live pattern, which content-dedup deliberately does NOT catch (different content).
  await server.processIncomingMessages([{ id: "phantom-1", phone, text: "", isGroup: false }]);
  assert.equal(sendTextSpy.mock.callCount(), repliesFromRealMessage,
    "the content-less companion must add ZERO further replies -- without this fix it re-answered the ready-to-confirm draft (\"I kept your request draft open.\" plus the same summary again)");
  assert.equal(getState(phone).pendingBuyIntake?.step, "confirm", "the draft itself must be completely unaffected by the phantom companion");
});

/**
 * Real reported bug, root-caused via live Railway deploy logs: two entries in the SAME webhook
 * batch, same phone, same second -- one content-less, one real -- both logged as "processing"
 * (neither flagged duplicate/phantom). The content-less one was listed FIRST in the batch, and
 * the existing phantom-companion check only ever looks backward at prior activity, so it found
 * nothing yet recorded for this phone and let the phantom through as a real, if content-less,
 * message. This must be caught regardless of which order Whapi lists the two entries in.
 */
test("required regression: a content-less companion listed BEFORE its real sibling in the SAME webhook batch is still recognized as the phantom", async (t) => {
  const sendTextSpy = t.mock.method(whapi, "sendText", async () => {});
  _resetContentDedupeForTests();
  _resetPhantomCompanionForTests();

  // Baseline: the real, complete request alone -- establishes how many replies it normally
  // produces (a summary plus a confirmation prompt is more than one message, which is normal
  // and has nothing to do with the phantom bug).
  const baselinePhone = fresh("15550781a").replace(/[^\d]/g, "");
  resetState(baselinePhone);
  await server.processIncomingMessages([{ id: "real-baseline-1", phone: baselinePhone, text: LIVE_SENTENCE, isGroup: false }]);
  const baselineReplies = sendTextSpy.mock.callCount();
  assert.ok(baselineReplies > 0, "precondition: the real, complete request alone gets at least one reply");

  // Single batch, single processIncomingMessages call -- the phantom (empty text) listed BEFORE
  // the real message, exactly the order confirmed live.
  sendTextSpy.mock.resetCalls();
  const phone = fresh("15550781b").replace(/[^\d]/g, "");
  resetState(phone);
  await server.processIncomingMessages([
    { id: "phantom-before-1", phone, text: "", isGroup: false },
    { id: "real-after-1", phone, text: LIVE_SENTENCE, isGroup: false },
  ]);

  assert.equal(sendTextSpy.mock.callCount(), baselineReplies, "the phantom listed first must add ZERO further replies beyond what the real message alone would produce");
  assert.equal(getState(phone).pendingBuyIntake?.step, "confirm", "the real message is still processed normally, landing on confirmation");
});

/**
 * Live-reported bug: a "Match ID# ... approve/pass" card reached the buyer on WhatsApp
 * BEFORE their own "Your WTB request is active" confirmation for the very request that match
 * card was about. Root cause: the match sweep used to notify inline, deep inside
 * ingestDirectBuyPosting, well before this turn's confirmation message had even been queued —
 * see FlowResult.pendingMatchNotifications / server.ts's post-messages send loop.
 */
test("required regression: the WTB confirmation is always sent before any match-card notification it triggers, never after", async (t) => {
  // A real FS candidate for the exact reference LIVE_SENTENCE names, so confirming produces at
  // least one match-card notification alongside the confirmation itself.
  await createDirectPosting({
    phone: fresh("15550782-seller").replace(/[^\d]/g, ""),
    type: "FS",
    description: "Rolex Daytona 116500LN black dial",
    brand: "Rolex",
    model: "Daytona",
    reference: "116500LN",
    price: 20000,
  });

  const phone = fresh("15550782").replace(/[^\d]/g, "");
  resetState(phone);
  await server.processIncomingMessages([{ id: "order-setup-1", phone, text: LIVE_SENTENCE, isGroup: false }]);
  assert.equal(getState(phone).pendingBuyIntake?.step, "confirm", "precondition: the complete request went straight to confirmation");

  const order: string[] = [];
  t.mock.method(whapi, "sendText", async (_recipient: string, message: string) => { order.push(message); });

  await server.processIncomingMessages([{ id: "order-confirm-1", phone, text: "confirm", isGroup: false }]);

  assert.ok(order.some((m) => /Match ID#/.test(m)), "precondition: confirming this exact reference must actually trigger a match-card notification");
  const confirmationIndex = order.findIndex((m) => /Your WTB request is active:/.test(m));
  const firstMatchCardIndex = order.findIndex((m) => /Match ID#/.test(m));
  assert.ok(confirmationIndex !== -1, "the confirmation itself must be sent");
  assert.ok(confirmationIndex < firstMatchCardIndex, "the confirmation must be sent before any match-card notification, never after");
});

test('required regression: a budget answered with a trailing currency CODE ("70,000 USD") is recognized, not just a leading symbol ("$70,000") -- real reported bug', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "WTB pikachu daytona");
  await handleIncomingMessage(identity, "Rolex pikachu daytona");
  const answered = await handleIncomingMessage(identity, "70,000 USD");
  assert.equal(getState(identity).pendingBuyIntake?.budget, 70000, "a number followed by a currency code must be recognized the same as one preceded by a $ sign");
  assert.equal(getState(identity).pendingBuyIntake?.currency, "USD");
  assert.doesNotMatch(answered.messages.join("\n"), /kept your request draft open|What's your maximum budget/i, "must not silently fail to parse and re-ask the same question");
});

test('required regression: a stated year is captured and carried through to the activated WTB posting -- real reported ask: "if a year is mentioned, only search for those"', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "WTB pikachu daytona");
  await handleIncomingMessage(identity, "Rolex pikachu daytona 2024");
  await handleIncomingMessage(identity, "$70,000");
  await handleIncomingMessage(identity, "US");
  assert.equal(getState(identity).pendingBuyIntake?.year, "2024", "the stated year must be captured into the draft");

  await handleIncomingMessage(identity, "confirm");
  const userId = await getOrCreateCanonicalUser(platformForIdentity(identity), identity);
  const active = await getActivePostingsForUser(userId);
  assert.equal(active.length, 1);
  assert.equal(active[0].year, "2024", "the year must survive onto the actual activated posting, not just the in-progress draft");
});

test('required regression: a bare reference ending in a letter suffix ("116518LN") is never misread as the budget -- real reported bug: "I am looking for 116518LN" silently set Maximum: $116,518 and skipped the budget question', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  const answered = await handleIncomingMessage(identity, "I am looking for 116518LN");
  assert.equal(getState(identity).pendingBuyIntake?.reference, "116518LN");
  assert.equal(getState(identity).pendingBuyIntake?.budget, undefined, "the digits in front of the reference's letter suffix must not be read as a price");
  assert.equal(getState(identity).pendingBuyIntake?.step, "budget", "the budget question must still be asked, never silently skipped");
  assert.match(answered.messages.join("\n"), /maximum budget/i);
});

test('required regression: a location reply of "all" is treated as no preference (same as "any"), not stored as the literal location "all" -- real reported ask: for location change \'all\' to \'global\'', async () => {
  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "WTB pikachu daytona");
  await handleIncomingMessage(identity, "Rolex pikachu daytona");
  await handleIncomingMessage(identity, "$70,000");
  assert.equal(getState(identity).pendingBuyIntake?.step, "location");
  await handleIncomingMessage(identity, "all");
  assert.equal(getState(identity).pendingBuyIntake?.location, "Global", 'a bare "all" answer must map to the same "no preference" location as "any", never be stored as the literal word "all"');
});

test("required: a shared location pin at the location step resolves through reverse geocoding and is stored the same as a typed answer", async (t) => {
  const geo = require("../geo/reverseGeocode") as typeof import("../geo/reverseGeocode");
  t.mock.method(geo, "reverseGeocode", async () => "Miami, United States");

  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "WTB pikachu daytona");
  await handleIncomingMessage(identity, "Rolex pikachu daytona");
  await handleIncomingMessage(identity, "$70,000");
  assert.equal(getState(identity).pendingBuyIntake?.step, "location");

  const answered = await handleIncomingMessage(identity, "", undefined, undefined, { latitude: 25.7617, longitude: -80.1918 });
  assert.equal(getState(identity).pendingBuyIntake?.location, "Miami, United States");
  assert.doesNotMatch(answered.messages.join("\n"), /couldn.t quite place/i);
});

test("required: a shared location pin that fails to resolve asks for a typed answer instead, and never corrupts the draft", async (t) => {
  const geo = require("../geo/reverseGeocode") as typeof import("../geo/reverseGeocode");
  t.mock.method(geo, "reverseGeocode", async () => null);

  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "WTB pikachu daytona");
  await handleIncomingMessage(identity, "Rolex pikachu daytona");
  await handleIncomingMessage(identity, "$70,000");

  const answered = await handleIncomingMessage(identity, "", undefined, undefined, { latitude: 0, longitude: 0 });
  assert.match(answered.messages.join("\n"), /city or country instead/i);
  assert.equal(getState(identity).pendingBuyIntake?.location, undefined, "a failed lookup must never set a made-up location");
  assert.equal(getState(identity).pendingBuyIntake?.step, "location", "must still be waiting on the same question");
});

test("required: a shared location pin is ignored (falls through to normal handling) outside the location step", async (t) => {
  const geo = require("../geo/reverseGeocode") as typeof import("../geo/reverseGeocode");
  const spy = t.mock.method(geo, "reverseGeocode", async () => "Miami, United States");

  const identity = fresh();
  resetState(identity);
  await handleIncomingMessage(identity, "hi");
  await handleIncomingMessage(identity, "", undefined, undefined, { latitude: 25.7617, longitude: -80.1918 });
  assert.equal(spy.mock.callCount(), 0, "a location share is only ever meaningful while Fi is actually asking about location");
});
