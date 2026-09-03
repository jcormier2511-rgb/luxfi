import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("../postings/db") as typeof import("../postings/db");
const inventory = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const store = require("../postings/postingsStore") as typeof import("../postings/postingsStore");
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
const { resetState, getState } = require("./stateStore") as typeof import("./stateStore");

after(async () => { await db._closePoolForTests(); await inventory._closePoolForTests(); });
beforeEach(async () => { await db._resetDbForTests(); await inventory._resetDbForTests(); });

/**
 * An open draft is not the default destination for every unmatched message.
 *
 * The live session showed the boundary backwards: with a WTB draft open, "hi" was stored as the
 * buyer's LOCATION, and "membership status" / "what plan am I on" were answered by reprinting
 * the draft — because the draft's answer handler was the catch-all that ran whenever no exact
 * command pattern matched. Routing order is now: account/session intents, then explicit
 * management/search commands, and only then a draft correction — and only when the message
 * actually reads like one.
 */

let counter = 0;
function freshPhone(): string {
  counter += 1;
  const phone = `telegram:5551900${String(counter).padStart(3, "0")}`;
  resetState(phone);
  return phone;
}

/** The reported draft, with the reported parse expectations asserted up front. */
async function openReportedDraft(phone: string): Promise<string> {
  await handleIncomingMessage(phone, "WTB Rolex 116500, black dial, pre-owned, max $35,000");
  const draft = getState(phone).pendingBuyIntake;
  assert.ok(draft, "expected an open WTB draft");
  assert.deepEqual(
    {
      brand: draft.brand, model: draft.model, reference: draft.reference,
      dial: draft.dialColor, condition: draft.condition, budget: draft.budget,
    },
    {
      brand: "rolex", model: undefined, reference: "116500",
      dial: "black", condition: "pre-owned", budget: 35000,
    },
    "the dial color must not be stored as the model"
  );
  return JSON.stringify(draft);
}

/** Every message that must be answered on its own terms, with the draft left alone. */
const INDEPENDENT_MESSAGES: ReadonlyArray<readonly [string, RegExp]> = [
  ["hi",                    /how can I help you today/i],
  ["hello",                 /how can I help you today/i],
  ["membership status",     /^Membership:/m],
  ["what plan am I on",     /^Membership:/m],
  ["my membership",         /^Membership:/m],
  ["do I have a subscription", /^Membership:/m],
  ["status",                /Approved matches/i],
  ["my status",             /Approved matches/i],
  ["my listings",           /active task/i],
  ["what am I buying",      /active task/i],
  ["market pulse 116500LN", /Market Pulse — 116500LN/],
  ["help",                  /here's what I can do/i],
];

for (const [message, expected] of INDEPENDENT_MESSAGES) {
  test(`"${message}" is answered independently and never touches the open draft`, async () => {
    const phone = freshPhone();
    await store.createDirectPosting({
      phone, type: "FS", description: "raw", brand: "Rolex", model: "Daytona",
      reference: "116500LN", price: 30000, currency: "USD",
    });
    const before = await openReportedDraft(phone);

    const reply = await handleIncomingMessage(phone, message);
    const text = reply.messages.join("\n");

    assert.match(text, expected);
    assert.doesNotMatch(text, /listing review/i, "must not reprint the draft");
    assert.doesNotMatch(text, /Should I start monitoring/i, "must not reprint the draft");
    assert.doesNotMatch(text, /kept your request draft open/i, "must not fall into intake handling");
    assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), before, "the draft must be unchanged");
  });
}

test("the full reported sequence: six independent commands, then one real correction", async () => {
  const phone = freshPhone();
  await store.createDirectPosting({
    phone, type: "FS", description: "raw", brand: "Rolex", model: "Daytona",
    reference: "116500LN", price: 30000, currency: "USD",
  });
  const before = await openReportedDraft(phone);

  for (const message of ["hi", "membership status", "status", "what plan am I on", "my listings", "market pulse 116500LN"]) {
    const reply = await handleIncomingMessage(phone, message);
    const text = reply.messages.join("\n");
    assert.doesNotMatch(text, /listing review/i, `"${message}" reprinted the draft`);
    assert.doesNotMatch(text, /kept your request draft open/i, `"${message}" fell into intake`);
    assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), before, `"${message}" modified the draft`);
  }

  // Only now, with a message that really is a correction, does the draft change — and only the
  // budget moves.
  const corrected = await handleIncomingMessage(phone, "change my budget to 32000");
  const draft = getState(phone).pendingBuyIntake!;
  assert.equal(draft.budget, 32000, "the correction must reach the draft");
  assert.equal(draft.reference, "116500", "and must not disturb the rest of it");
  assert.equal(draft.dialColor, "black");
  assert.equal(draft.condition, "pre-owned");
  assert.equal(draft.model, undefined);
  assert.match(corrected.messages.join("\n"), /location/i, "the interview carries on from where it was");
});

test("an index-less budget change goes to the draft, not to a stored listing", async () => {
  const phone = freshPhone();
  const listing = await store.createDirectPosting({
    phone, type: "FS", description: "raw", brand: "Rolex", model: "Daytona",
    reference: "116500LN", price: 30000, currency: "USD",
  });
  await openReportedDraft(phone);

  await handleIncomingMessage(phone, "change my budget to 32000");
  assert.equal(getState(phone).pendingBuyIntake?.budget, 32000);
  assert.equal(Number((await store.getPosting(listing.id))?.price), 30000, "the stored listing must be untouched");

  // A numbered command is unambiguous and still wins over the draft.
  await handleIncomingMessage(phone, "change listing 1 price to 27000");
  assert.equal(Number((await store.getPosting(listing.id))?.price), 27000);
  assert.equal(getState(phone).pendingBuyIntake?.budget, 32000, "and leaves the draft alone");
});

test("the location step accepts a place, and refuses to swallow anything else", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "WTB Rolex 116500, black dial, pre-owned, max $35,000");
  assert.equal(getState(phone).pendingBuyIntake?.step, "location", "the draft is waiting on a location");

  // The live bug: any text at all was accepted here, so "hi" became the buyer's location.
  await handleIncomingMessage(phone, "hi");
  assert.equal(getState(phone).pendingBuyIntake?.location, undefined);
  await handleIncomingMessage(phone, "membership status");
  assert.equal(getState(phone).pendingBuyIntake?.location, undefined);

  // A real answer still lands.
  await handleIncomingMessage(phone, "Hong Kong");
  assert.equal(getState(phone).pendingBuyIntake?.location, "Hong Kong");
});

test("a greeting with a real request in it is still a request, not just a greeting", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "hi");
  const reply = await handleIncomingMessage(phone, "hi, WTB Rolex 116500LN, pre-owned, usa, max $28,000");
  // The intake opened and is asking its next question, rather than the whole message being
  // answered as a bare "hi".
  assert.doesNotMatch(reply.messages.join("\n"), /how can I help you today/i);
  const draft = getState(phone).pendingBuyIntake!;
  assert.equal(draft.reference, "116500LN");
  assert.equal(draft.budget, 28000);
  assert.equal(draft.condition, "pre-owned");
});

test("a brand-new contact's first greeting still gets onboarding, not the short greeting", async () => {
  const phone = freshPhone();
  const first = await handleIncomingMessage(phone, "hello");
  assert.match(first.messages[0], /personal luxury concierge/i);
  const second = await handleIncomingMessage(phone, "hello");
  assert.doesNotMatch(second.messages[0], /personal luxury concierge/i);
  assert.match(second.messages[0], /how can I help you today/i);
});

/**
 * Live session: answering "any" to "What condition do you prefer?" got the SAME question back,
 * every time. A bare "any" also satisfies the dial-color pattern, so it set the dial, counted as
 * a change, and the only code that could set condition from it never ran. The interview could
 * not be completed by answering it as asked — the reported session escaped by typing "preowned".
 */
test("the reported interview completes with 'any' answered to every question", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "i want to buy a rolex");
  await handleIncomingMessage(phone, "35000");

  const seen: string[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    const draft = getState(phone).pendingBuyIntake;
    if (!draft || draft.step === "confirm") break;
    const reply = await handleIncomingMessage(phone, "any");
    const asked = reply.messages.join("\n");
    assert.ok(!seen.includes(asked), `Fi repeated a question it had already asked: ${asked.slice(0, 60)}`);
    seen.push(asked);
  }

  const draft = getState(phone).pendingBuyIntake!;
  assert.equal(draft.step, "confirm", "answering every question must finish the interview");
  assert.equal(draft.condition, "any");
  assert.equal(draft.location, "any");
});

const BARE_QUALIFIERS = ["any", "either", "no preference", "doesn't matter", "whatever"];
for (const qualifier of BARE_QUALIFIERS) {
  test(`"${qualifier}" answers the question actually being asked`, async () => {
    const phone = freshPhone();
    await handleIncomingMessage(phone, "i want to buy a rolex");
    await handleIncomingMessage(phone, "35000");
    await handleIncomingMessage(phone, "any"); // the model question
    assert.equal(getState(phone).pendingBuyIntake?.step, "condition");

    await handleIncomingMessage(phone, qualifier);
    const draft = getState(phone).pendingBuyIntake!;
    assert.equal(draft.condition, "any", `"${qualifier}" must answer condition`);
    assert.notEqual(draft.step, "condition", "and must not re-ask it");
  });
}

/** Answers people actually type. None may leave the interview asking the same thing again, and
 *  none may be re-read as item identity — "NY 10001" carries a reference-shaped token, which
 *  used to overwrite the draft's description and reference with the customer's own postcode. */
const LOCATION_ANSWERS = ["usa", "USA!", "Miami, FL", "NY 10001", "UK/EU", "Hong Kong", "Los Angeles, CA 90001", "worldwide"];
for (const answer of LOCATION_ANSWERS) {
  test(`"${answer}" is accepted as a location, and only as a location`, async () => {
    const phone = freshPhone();
    await handleIncomingMessage(phone, "WTB Rolex 116500LN, black dial, pre-owned, max $35,000");
    assert.equal(getState(phone).pendingBuyIntake?.step, "location", "precondition: waiting on a location");

    const reply = await handleIncomingMessage(phone, answer);
    const draft = getState(phone).pendingBuyIntake!;
    assert.notEqual(draft.step, "location", `"${answer}" left the interview stuck re-asking`);
    assert.ok(draft.location, "the answer must be stored");
    assert.equal(draft.reference, "116500LN", "identity must survive a location answer");
    assert.match(reply.messages.join("\n"), /116500LN/, "the summary must still describe the watch");
  });
}

/**
 * Found by running the live script rather than by the suite: with the draft waiting on a
 * location, "change my budget to 32000" correctly repriced it AND stored the whole sentence as
 * the location. The scoped answer and the free-text location fallback were computed
 * independently, so both fired on one message.
 */
test("a field correction sent while awaiting a location does not become the location", async () => {
  for (const correction of ["change my budget to 32000", "change my price to 28000", "make the budget 30000"]) {
    const phone = freshPhone();
    await handleIncomingMessage(phone, "WTB Rolex 116500, black dial, pre-owned, max $35,000");
    assert.equal(getState(phone).pendingBuyIntake?.step, "location", "precondition: waiting on a location");

    const reply = await handleIncomingMessage(phone, correction);
    const draft = getState(phone).pendingBuyIntake!;
    assert.equal(draft.location, undefined, `"${correction}" was stored as the location`);
    assert.notEqual(draft.budget, 35000, "the correction must still have been applied");
    assert.match(reply.messages.join("\n"), /location/i, "and Fi still asks for the location it never got");
  }
});

test("a genuine place is still accepted as a free-text location", async () => {
  for (const [place, expected] of [["Hong Kong", "Hong Kong"], ["Miami, FL", "Miami, FL"], ["NY 10001", "NY 10001"]] as const) {
    const phone = freshPhone();
    await handleIncomingMessage(phone, "WTB Rolex 116500, black dial, pre-owned, max $35,000");
    await handleIncomingMessage(phone, place);
    assert.equal(getState(phone).pendingBuyIntake?.location, expected);
  }
});
