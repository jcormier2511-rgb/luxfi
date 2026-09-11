import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-commands-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlementStore = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState, getState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await entitlementStore._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "28000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

test('required: "help" shows the Fi menu', async () => {
  resetState("19991110001");
  const result = await handleIncomingMessage("19991110001", "help");
  assert.match(result.messages[0], /here's what I can do/i);
  assert.match(result.messages[0], /"cancel"/);
  assert.match(result.messages[0], /"status"/);
  assert.match(result.messages[0], /market pulse/i, "required regression: market research must be discoverable from the help menu");
});

test('required: "/help" shows the Fi menu and never gets replaced by onboarding', async () => {
  const phone = "19991110011";
  resetState(phone);
  const help = await handleIncomingMessage(phone, "/help");
  assert.match(help.messages[0], /here's what I can do/i);
  assert.match(help.messages[0], /"cancel"/);
  assert.doesNotMatch(help.messages[0], /personal luxury concierge/i);

  const ordinary = await handleIncomingMessage(phone, "hello");
  assert.match(ordinary.messages[0], /personal luxury concierge/i, "help must not consume first-contact onboarding");
});

test('required: "/start" returns the configured onboarding intro', async () => {
  const phone = "19991110012";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "/start");
  assert.match(result.messages[0], /personal luxury concierge/i);
  assert.equal(result.state.stage, "active");
});

test('required regression: a Telegram deep-link payload ("/start join", from t.me/Luxfi_Fi_Bot?start=join -- the website\'s own "Message Fi" button) still shows the onboarding intro', async () => {
  // Live-reported bug: the website's "Message Fi" button is a Telegram deep link with a payload
  // (?start=join), which Telegram's own client always delivers as "/start join", never a bare
  // "/start". The old check required an EXACT match against "start" alone, so this button never
  // showed the intro message at all -- a customer clicking it landed on a generic fallback
  // instead of onboarding. Telegram may attach a different payload in the future ("start hi",
  // etc.); any of them must still trigger the same intro.
  const phone = "19991110020";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "/start join");
  assert.match(result.messages[0], /personal luxury concierge/i);
  assert.equal(result.state.stage, "active");

  const phone2 = "19991110021";
  resetState(phone2);
  const withDifferentPayload = await handleIncomingMessage(phone2, "start hi");
  assert.match(withDifferentPayload.messages[0], /personal luxury concierge/i, "any deep-link payload must work, not only the one payload in use today");
});

test('required: "start" (the website\'s "Message Fi" button, which now sends plain "start" instead of a full sentence) still asks for a name when the visitor\'s WhatsApp/Telegram profile has none', async () => {
  const phone = "19991110024";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "start");
  assert.match(result.messages[0], /personal luxury concierge/i, "the intro is still shown first");
  assert.match(result.messages.join("\n"), /may I have your name/i);

  const named = await handleIncomingMessage(phone, "Alex");
  assert.match(named.messages.join("\n"), /Nice to meet you, Alex/i);
});

test('required: "start" never asks for a name when the channel already supplied one', async () => {
  const phone = "19991110025";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "start", { phone, name: "Jordan Lee", tier: "A" });
  assert.match(result.messages[0], /personal luxury concierge/i);
  assert.doesNotMatch(result.messages.join("\n"), /may I have your name/i);
});

test('required: "start" never re-asks for a name Fi already collected from a previous exchange', async () => {
  const phone = "19991110026";
  resetState(phone);
  await handleIncomingMessage(phone, "hi"); // organic first contact -- asks for a name
  await handleIncomingMessage(phone, "Alex"); // ...and gets one

  const result = await handleIncomingMessage(phone, "start"); // later, e.g. a website re-click
  assert.match(result.messages[0], /personal luxury concierge/i);
  assert.doesNotMatch(result.messages.join("\n"), /may I have your name/i, "Fi already knows this contact's name");
});

test('required regression: "restart"/"starting" never trigger the onboarding intro just because they open with the letters "start"', async () => {
  const phone = "19991110022";
  resetState(phone);
  await handleIncomingMessage(phone, "hi"); // move past first-contact onboarding first
  const result = await handleIncomingMessage(phone, "starting fresh here");
  assert.doesNotMatch(result.messages.join("\n"), /personal luxury concierge/i);
});

test('required regression: a bare "start over" still reaches the friendlier reset reply, not the plain onboarding intro', async () => {
  // The new deep-link-payload tolerance on "/start" must not swallow RESET_COMMAND's own
  // "start over" phrase -- a customer typing that expects the same "I think I got confused
  // somewhere -- let's start over" + menu reply "I'm confused" already gets, not the (correct,
  // but different) unrelated onboarding intro.
  const phone = "19991110023";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "start over");
  assert.match(result.messages[0], /let's start over/i);
  assert.doesNotMatch(result.messages[0], /personal luxury concierge/i);
});

test("help and onboarding routing are identical across WhatsApp, Telegram, and SMS identities", async () => {
  for (const identity of ["whatsapp:19991110013", "telegram:991110014", "sms:19991110015"]) {
    resetState(identity);
    const help = await handleIncomingMessage(identity, "help");
    assert.match(help.messages[0], /here's what I can do/i, `${identity}: help must be deterministic`);
    const ordinary = await handleIncomingMessage(identity, "hello");
    assert.match(ordinary.messages[0], /personal luxury concierge/i, `${identity}: ordinary first contact gets onboarding`);
    const later = await handleIncomingMessage(identity, "hello");
    assert.doesNotMatch(later.messages[0], /personal luxury concierge/i, `${identity}: onboarding is one-shot`);
  }
});

test("a brand-new contact can opt out without receiving onboarding first", async () => {
  const phone = "19991110016";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "STOP");
  assert.deepEqual(result.messages, ["You're unsubscribed — you won't hear from Fi again. Reply START anytime to opt back in."]);
  assert.equal(result.state.stage, "opted_out");
});

test('"menu" is a synonym for "help"', async () => {
  resetState("19991110002");
  const result = await handleIncomingMessage("19991110002", "menu");
  assert.match(result.messages[0], /here's what I can do/i);
});

test('required: "status" reports approval usage and pending decisions honestly, without guessing', async () => {
  resetState("19991110003");
  const result = await handleIncomingMessage("19991110003", "status");
  assert.match(result.messages[0], /Approved matches: 0\/3/);
  assert.match(result.messages[0], /No matches currently awaiting a decision/);
});

test('required: "cancel" clears a pending match without unsubscribing the contact', async () => {
  const phone = "19991110004";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("cancel-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const searchResult = await handleIncomingMessage(phone, "any");
  assert.ok(searchResult.state.pendingMatches, "a match must be pending before cancel is tested");

  const cancelResult = await handleIncomingMessage(phone, "cancel");
  assert.match(cancelResult.messages[0], /cleared your current matches/i);
  assert.equal(cancelResult.state.pendingMatches, undefined);
  assert.notEqual(cancelResult.state.stage, "opted_out", "cancel must never unsubscribe the contact");

  // Still a fully active contact afterward -- a new search works normally.
  const stillActive = await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  assert.ok(stillActive.messages.some((m) => /Potential Match/.test(m)));
});

test('"cancel" with nothing pending says so rather than pretending something was cleared', async () => {
  resetState("19991110005");
  const result = await handleIncomingMessage("19991110005", "cancel");
  assert.match(result.messages[0], /nothing pending to cancel/i);
});

test('required (live-reported confusion): "I\'m confused, let\'s start over" escapes a stuck pendingReplacementRequest prompt, same as "cancel" would', async () => {
  const phone = "19991110017";
  resetState(phone);
  await inventoryDb._resetDbForTests();

  await handleIncomingMessage(phone, "hi");
  const draft = await handleIncomingMessage(phone, "Sell my Rolex Daytona 116500LN black dial, pre-owned, full set, Miami");
  assert.equal(draft.state.pendingSellIntake?.step, "price", "the draft must be waiting on a price for this reproduction");

  // A second, fresh sell request while that draft is still open arms the "replace or add
  // another" prompt -- the exact state the live user got stuck behind.
  const conflict = await handleIncomingMessage(phone, "Sell my Rolex Daytona 116500LN black dial, pre-owned, full set, Miami");
  assert.ok(conflict.state.pendingReplacementRequest, "the replace/add prompt must be pending before the reset command is tested");
  assert.match(conflict.messages[0], /replace it or add another/i);

  const reset = await handleIncomingMessage(phone, "I'm confused, let's start over");
  assert.match(reset.messages[0], /let's start over/i);
  assert.match(reset.messages[1], /here's what I can do/i, "the reset reply includes the full Fi menu, same as the automatic stuck-intake bailout");
  assert.equal(reset.state.pendingReplacementRequest, undefined);
  assert.equal(reset.state.pendingSellIntake, undefined);

  // Fully unstuck afterward -- a new request works normally, with no leftover replace/add prompt.
  const fresh = await handleIncomingMessage(phone, "Sell my Rolex Daytona 116500LN black dial, pre-owned, full set, Miami");
  assert.equal(fresh.state.pendingReplacementRequest, undefined);
  assert.equal(fresh.state.pendingSellIntake?.step, "price");
});

test('"start over" and "reset" reach the same universal recovery as "I\'m confused"', async () => {
  const phone = "19991110018";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("reset-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const searchResult = await handleIncomingMessage(phone, "any");
  assert.ok(searchResult.state.pendingMatches, "a match must be pending before the reset command is tested");

  const result = await handleIncomingMessage(phone, "can we start over please");
  assert.match(result.messages[0], /let's start over/i);
  assert.equal(result.state.pendingMatches, undefined);
  assert.notEqual(result.state.stage, "opted_out", "the reset command must never unsubscribe the contact");

  resetState("19991110019");
  const bareReset = await handleIncomingMessage("19991110019", "reset");
  assert.match(bareReset.messages[0], /let's start over/i);
});

test('required (live-reported bug): after the only match is already approved, "hi" gets a personalized greeting, not the stale approve/pass reminder', async () => {
  const phone = "19991110006";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("hi-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const approve = await handleIncomingMessage(phone, "approve 1");
  assert.match(approve.messages.join("\n"), /^Approved #1/);
  assert.ok(
    approve.messages.some((m) => /escrow and inspection partners/i.test(m)),
    "a real connection reveal must suggest escrow/inspection partners as a follow-up"
  );

  const hiResult = await handleIncomingMessage(phone, "hi", { phone, name: "John Smith", tier: "A" });
  assert.match(hiResult.messages[0], /^Hi John, how can I help you today\?$/);
  assert.doesNotMatch(hiResult.messages[0], /FI727/, "the escrow offer is one-shot — an unrelated reply must never retrigger it");
  assert.doesNotMatch(hiResult.messages[0], /approve <number>/i, "must never show the stale reminder once nothing is left to decide");
});

test('required: replying "yes" right after a connection reveal gets the escrow/inspection promo code', async () => {
  const phone = "19991110009";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("escrow-yes-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "approve 1");

  const yesResult = await handleIncomingMessage(phone, "yes");
  assert.match(yesResult.messages.join("\n"), /FI727/, "a 'yes' to the escrow offer must return the promo code");
  assert.match(yesResult.messages.join("\n"), /first escrow\/inspection service free/i);
  assert.match(yesResult.messages.join("\n"), /50% off future services/i);

  // One-shot: asking again afterward (with nothing pending) must not repeat the offer.
  const followUp = await handleIncomingMessage(phone, "yes");
  assert.doesNotMatch(followUp.messages.join("\n"), /FI727/, "the offer must not fire again once already consumed");
});

test('required: a non-affirmative reply right after a connection reveal does not get the promo code, and is still handled normally', async () => {
  const phone = "19991110010";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("escrow-no-1")], new Date().toISOString());

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "approve 1");

  const result = await handleIncomingMessage(phone, "status");
  assert.doesNotMatch(result.messages.join("\n"), /FI727/, "a non-affirmative reply must never get the promo code");
  assert.match(result.messages.join("\n"), /Approved matches/, "the message must still be handled normally (the 'status' command here), not swallowed");
});

/**
 * Real reported bug: the escrow offer said "just ask and I can connect you", which is not
 * something the deterministic router can recognize -- a reply like "connect me" (not "yes")
 * fell straight through to the generic fallback. "escrow" (the word the suggestion now actually
 * names) works as a real, durable command: any time, not only as a same-turn reply to a
 * just-approved match.
 */
test('required regression: mentioning "escrow" at any time gets the promo code, not only as a one-shot reply right after an approval', async () => {
  const phone = "19991110011";
  resetState(phone);

  const cold = await handleIncomingMessage(phone, "escrow");
  assert.match(cold.messages.join("\n"), /FI727/, "\"escrow\" must work even with no pending offer at all");

  // "connect me" is exactly the real reported failure -- it must never itself get the promo
  // code (only "escrow" or the existing "yes" one-shot do), confirming this isn't a blanket
  // "anything after an approval works" regression.
  resetState(phone);
  const notRecognized = await handleIncomingMessage(phone, "connect me");
  assert.doesNotMatch(notRecognized.messages.join("\n"), /FI727/);
});

test('required regression: "escrow" mentioned mid-draft is answered directly, not swallowed as an answer to whatever the draft is asking', async () => {
  const phone = "19991110012";
  resetState(phone);

  const started = await handleIncomingMessage(phone, "WTB Rolex Daytona");
  assert.ok(started.state.pendingBuyIntake, "precondition: a draft is now open");

  const result = await handleIncomingMessage(phone, "what about escrow");
  assert.match(result.messages.join("\n"), /FI727/);
  assert.doesNotMatch(result.messages.join("\n"), /kept your request draft open/, "escrow must be answered directly, not treated as a non-advancing draft answer");
  assert.deepEqual(getState(phone).pendingBuyIntake, started.state.pendingBuyIntake, "the draft itself must be completely unaffected by the escrow question");
});

test('required (live-reported bug): "Photos2" and "approve1" (no space before the number) are recognized the same as with a space', async () => {
  const phone = "19991110007";
  resetState(phone);
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("nospace-1", { contactPhone: "10000000001" }), fsRow("nospace-2", { contactPhone: "10000000002" })],
    new Date().toISOString()
  );

  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  const search = await handleIncomingMessage(phone, "any");
  assert.equal(search.state.pendingMatches!.matches.length, 2, "setup: two candidates must be shown");

  const photosNoSpace = await handleIncomingMessage(phone, "Photos2");
  assert.match(photosNoSpace.messages.join("\n"), /Photo request sent for #2/, '"Photos2" must resolve to match #2, not fall through to general chat');

  const approveNoSpace = await handleIncomingMessage(phone, "approve1");
  assert.match(approveNoSpace.messages.join("\n"), /^Approved #1/, '"approve1" must resolve to match #1');
});
