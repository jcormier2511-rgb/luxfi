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
 * Regression coverage for the live Telegram session that still failed the listing-management /
 * WTB-parsing / market-intelligence contract after the previous stabilization rounds. Each test
 * here reproduces a message sequence that was observed misbehaving in production, not a
 * hypothetical one.
 */

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  const phone = `telegram:5551200${String(phoneCounter).padStart(3, "0")}`;
  resetState(phone);
  return phone;
}

async function makeListing(
  phone: string,
  type: "FS" | "WTB",
  reference: string,
  price: number,
  extra: Record<string, unknown> = {}
) {
  return store.createDirectPosting({
    phone, type, description: `historical raw text ${reference}`,
    brand: "Rolex", model: "Daytona", reference, price, currency: "USD", ...extra,
  } as Parameters<typeof store.createDirectPosting>[0]);
}

/** The exact typo'd phrasing from the live session that produced Model: "i want ot buy a". */
const LIVE_TYPO_WTB = "WTB i want ot buy a rolex, preowned, usa, maximum $2,500";

async function openBuyDraft(phone: string, text = LIVE_TYPO_WTB): Promise<string> {
  await handleIncomingMessage(phone, text);
  const draft = getState(phone).pendingBuyIntake;
  assert.ok(draft, "expected an open WTB draft");
  return JSON.stringify(draft);
}

const priceOf = async (id: number) => Number((await store.getPosting(id))?.price);
const statusOf = async (id: number) => (await store.getPosting(id))?.status;

// ---------------------------------------------------------------------------------------------
// 1. Listing management must override pending intake
// ---------------------------------------------------------------------------------------------

test("an explicit listing edit beats an open WTB draft instead of retargeting its budget", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const draftBefore = await openBuyDraft(phone);

  const reply = await handleIncomingMessage(phone, "edit listing 1 price 2500");
  const text = reply.messages.join("\n");

  assert.match(text, /Updated:[\s\S]*116500LN[\s\S]*Asking: \$2,500/);
  assert.doesNotMatch(text, /listing review/i);
  assert.doesNotMatch(text, /Should I start monitoring/i);
  assert.equal(await priceOf(one.id), 2500, "listing 1 must change");
  assert.equal(await priceOf(two.id), 14000, "listing 2 must not change");
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore, "the WTB draft must be untouched");
});

/** Every phrasing the contract requires, each driven with a WTB draft open so a parse miss shows
 *  up as a mutated draft rather than as a silently-unrecognized command. */
const PRICE_COMMANDS = [
  "edit listing 1 price 2500",
  "edit listing 1 price to 2500",
  "change listing 1 price to 2500",
  "change price listing 1 to 2500",
  "listing 1 price 2500",
  "change listing 1 budget to 2500",
];

for (const command of PRICE_COMMANDS) {
  test(`"${command}" repoints listing 1's price and never the pending draft`, async () => {
    const phone = freshPhone();
    const one = await makeListing(phone, "FS", "116500LN", 30000);
    const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
    const draftBefore = await openBuyDraft(phone);

    const reply = await handleIncomingMessage(phone, command);
    assert.match(reply.messages.join("\n"), /Updated:/);
    assert.equal(await priceOf(one.id), 2500);
    assert.equal(await priceOf(two.id), 14000);
    assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);
  });
}

test("location and dial edits accept the number before or after the field name", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000, { location: "Canada", dialColor: "black" });
  const draftBefore = await openBuyDraft(phone);

  await handleIncomingMessage(phone, "change listing 1 location to usa");
  assert.equal((await store.getPosting(one.id))?.location, "usa");

  await handleIncomingMessage(phone, "change location listing 1 to canada");
  assert.equal((await store.getPosting(one.id))?.location, "canada");

  await handleIncomingMessage(phone, "change listing 1 dial to white");
  assert.equal((await store.getPosting(one.id))?.dial, "white");

  assert.equal(await priceOf(one.id), 30000, "an identity edit must not touch price");
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);
});

test("pause/resume/close/delete each act on the numbered listing with a draft open", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const draftBefore = await openBuyDraft(phone);

  await handleIncomingMessage(phone, "pause listing 1");
  assert.equal(await statusOf(one.id), "paused");
  assert.equal(await statusOf(two.id), "active");

  await handleIncomingMessage(phone, "resume listing 1");
  assert.equal(await statusOf(one.id), "active");

  await handleIncomingMessage(phone, "close listing 1");
  assert.equal(await statusOf(one.id), "stopped");

  // Listing 2 is now the only manageable row left, so it is listing 1 in the renumbered view.
  await handleIncomingMessage(phone, "delete listing 1");
  assert.equal(await statusOf(two.id), "stopped");

  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);
});

test("closing multiple listings by number in one message closes each one, with a draft open", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const draftBefore = await openBuyDraft(phone);

  // Live-reported failure: this fell through to the open WTB draft's answer handler and
  // reported "I kept your request draft open" instead of closing either listing.
  const reply = await handleIncomingMessage(phone, "close listing 1 and 2");
  const text = reply.messages.join("\n");
  assert.doesNotMatch(text, /kept your request draft open/i);
  assert.equal(await statusOf(one.id), "stopped");
  assert.equal(await statusOf(two.id), "stopped");
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore, "the WTB draft must be untouched");
});

test("pause listing 1, 2 & 3 accepts commas and an ampersand between indices", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const three = await makeListing(phone, "WTB", "116500", 25000);

  await handleIncomingMessage(phone, "pause listing 1, 2 & 3");
  assert.equal(await statusOf(one.id), "paused");
  assert.equal(await statusOf(two.id), "paused");
  assert.equal(await statusOf(three.id), "paused");
});

test('"close 1 and 2" (no "listing" said at all) still closes both', async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });

  // Live-reported follow-up failure: dropping the word "listing" entirely ("close 1 and 2"
  // instead of "close listing 1 and 2") still fell through to the open draft's answer handler.
  const reply = await handleIncomingMessage(phone, "close 1 and 2");
  assert.doesNotMatch(reply.messages.join("\n"), /kept your request draft open/i);
  assert.equal(await statusOf(one.id), "stopped");
  assert.equal(await statusOf(two.id), "stopped");
});

test('"pause 1" (no "listing" said at all) still pauses it', async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  await handleIncomingMessage(phone, "pause 1");
  assert.equal(await statusOf(one.id), "paused");
});

test('"close all listings" closes every listing with no number said at all', async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const three = await makeListing(phone, "WTB", "116500", 25000);

  // Live-reported follow-up failure: no digit at all ("all" instead of "1 and 2 and 3") also
  // fell through to the open draft's answer handler.
  const reply = await handleIncomingMessage(phone, "close all listings");
  assert.doesNotMatch(reply.messages.join("\n"), /kept your request draft open/i);
  assert.equal(await statusOf(one.id), "stopped");
  assert.equal(await statusOf(two.id), "stopped");
  assert.equal(await statusOf(three.id), "stopped");
});

test('"close all listings" beats an open draft too, just like a specific listing number', async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const draftBefore = await openBuyDraft(phone);

  const reply = await handleIncomingMessage(phone, "close all listings");
  assert.doesNotMatch(reply.messages.join("\n"), /kept your request draft open/i);
  assert.equal(await statusOf(one.id), "stopped");
  assert.equal(await statusOf(two.id), "stopped");
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore, "the WTB draft must be untouched");
});

test('"pause all my listings" accepts the "my" variant, and reports gracefully with none', async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  await handleIncomingMessage(phone, "pause all my listings");
  assert.equal(await statusOf(one.id), "paused");

  const empty = freshPhone();
  const reply = await handleIncomingMessage(empty, "close all listings");
  assert.match(reply.messages.join("\n"), /no listings to manage/i);
});

test("an intake answer that names no listing number still reaches the draft", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  await openBuyDraft(phone);

  await handleIncomingMessage(phone, "change price to 36500");
  assert.equal(getState(phone).pendingBuyIntake?.budget, 36500, "a bare field correction belongs to the draft");
  assert.equal(await priceOf(one.id), 30000, "and must not touch a listing");
});

// ---------------------------------------------------------------------------------------------
// 2. Conversational filler must never be stored as the model
// ---------------------------------------------------------------------------------------------

test("the live typo'd WTB stores clean structured fields, not its own lead-in", async () => {
  const phone = freshPhone();
  const reply = await handleIncomingMessage(phone, LIVE_TYPO_WTB);
  const draft = getState(phone).pendingBuyIntake!;

  assert.equal(draft.brand, "rolex");
  assert.equal(draft.model, undefined, "lead-in language must not become the model");
  assert.equal(draft.reference, null);
  assert.equal(draft.condition, "pre-owned");
  assert.equal(draft.budget, 2500);
  assert.equal(draft.location, "USA");

  const text = reply.messages.join("\n");
  assert.doesNotMatch(text, /Model:|Not provided/, "a model the customer never gave is absent, not a placeholder");
  assert.doesNotMatch(text, /ot buy/i);
  assert.doesNotMatch(text, /i want/i);
});

const FILLER_LEAD_INS = [
  "i want to buy",
  "i want ot buy",
  "want to buy",
  "want ot buy",
  "looking for",
  "need",
  "wtb",
  "buy",
];

for (const lead of FILLER_LEAD_INS) {
  test(`"${lead}" is intent language, never a model`, async () => {
    const phone = freshPhone();
    await handleIncomingMessage(phone, `WTB ${lead} a rolex, preowned, usa, maximum $2,500`);
    const draft = getState(phone).pendingBuyIntake!;
    assert.equal(draft.brand, "rolex");
    assert.equal(draft.model, undefined, `"${lead}" leaked into the model`);
    assert.doesNotMatch(draft.description ?? "", new RegExp(lead.replace(/\s+/g, "\\s+"), "i"), "the lead-in must not survive into the description either");
  });
}

test("a real model after the brand is still captured", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "WTB i want to buy a rolex daytona, preowned, usa, maximum $28,000");
  const draft = getState(phone).pendingBuyIntake!;
  assert.equal(draft.brand, "rolex");
  assert.equal(draft.model, "daytona");
});

test("the cleaned draft persists clean fields to the posting row", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, LIVE_TYPO_WTB);
  await handleIncomingMessage(phone, "confirm");

  const shown = await handleIncomingMessage(phone, "my listings");
  const text = shown.messages.join("\n");
  assert.match(text, /1\. WTB — Rolex\n/, "the stored identity is brand-only, with no filler model");
  assert.doesNotMatch(text, /ot buy/i);
});

/**
 * Second live session, same failure family: "WTB rolex 116500 black dial, ..." reported
 *   Brand: Rolex / Model: black / Reference: 116500 / Dial: black
 * The dial color already has its own slot, so putting it in the model duplicated it and invented
 * an identity the user never gave. Individual descriptor words are never deleted, though — a
 * model genuinely built from them has to survive.
 */
test("a dial color is never stored as the model", async () => {
  const phone = freshPhone();
  const reply = await handleIncomingMessage(phone, "WTB rolex 116500 black dial, pre-owned, usa, maximum $35,000");
  const draft = getState(phone).pendingBuyIntake!;

  assert.equal(draft.brand, "rolex");
  // The reference IS the model here: 116500 names a Daytona. What must never happen is the
  // dial colour standing in for it — the live defect this test was written for.
  assert.equal(draft.model, "Daytona", "the reference implies the model");
  assert.notEqual(draft.model, "black", "the dial color must not become the model");
  assert.equal(draft.reference, "116500");
  assert.equal(draft.dialColor, "black", "and it must still be captured as the dial");
  assert.match(reply.messages.join("\n"), /WTB — Rolex Daytona 116500/);
});

const MODEL_EXTRACTION_CASES: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
  // message                                                    model              dial
  // 116500/116500LN name a Daytona; the reference supplies the model the message left unsaid.
  ["WTB rolex 116500 black dial, usa, maximum $35,000",         "Daytona",         "black"],
  ["WTB rolex 116500LN white dial pre-owned in the US for $28,000", "Daytona",     "white"],
  ["WTB rolex daytona white dial, usa, maximum $35,000",        "daytona",         "white"],
  // The color leads here, so a catch-all "truncate from the word dial" would have eaten the
  // model along with it.
  ["WTB rolex black dial daytona, usa, maximum $35,000",        "daytona",         "black"],
  // A real model built out of descriptor words has to survive intact.
  ["WTB tudor black bay, usa, maximum $3,500",                  "black bay",       undefined],
  ["WTB omega speedmaster professional, usa, maximum $6,000",   "speedmaster professional", undefined],
];

for (const [message, model, dial] of MODEL_EXTRACTION_CASES) {
  test(`model/dial split for "${message.slice(0, 46)}…"`, async () => {
    const phone = freshPhone();
    await handleIncomingMessage(phone, message);
    const draft = getState(phone).pendingBuyIntake!;
    assert.equal(draft.model, model);
    assert.equal(draft.dialColor, dial);
  });
}

test("a descriptor-only model is not persisted to the posting row either", async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "WTB rolex 116500 black dial, pre-owned, usa, maximum $35,000");
  await handleIncomingMessage(phone, "confirm");
  const shown = await handleIncomingMessage(phone, "my listings");
  const text = shown.messages.join("\n");
  assert.match(text, /1\. WTB — Rolex Daytona 116500\n/, "identity is brand + implied model + reference, with no color in it");
  assert.match(text, /black dial/, "the dial is still shown from its own field");
});

// ---------------------------------------------------------------------------------------------
// 3. "market pulse <reference>" must route deterministically
// ---------------------------------------------------------------------------------------------

const MARKET_REFERENCE_COMMANDS = [
  "market pulse 116500LN",
  "market pulse Rolex 116500LN",
  "market 116500LN",
  "price pulse 116500LN",
];

for (const command of MARKET_REFERENCE_COMMANDS) {
  test(`"${command}" returns the database pulse and never falls into pending intake`, async () => {
    const phone = freshPhone();
    await makeListing(phone, "FS", "116500LN", 30000);
    await makeListing("telegram:5559000001", "FS", "116500LN", 40000);
    const draftBefore = await openBuyDraft(phone);

    const reply = await handleIncomingMessage(phone, command);
    const text = reply.messages.join("\n");

    assert.match(text, /Market Pulse — (?:Rolex )?116500LN/);
    assert.match(text, /FS: 2 active listings/);
    assert.match(text, /Average FS ask: \$35,000/);
    assert.doesNotMatch(text, /listing review/i);
    assert.doesNotMatch(text, /Should I start monitoring/i);
    assert.doesNotMatch(text, /kept your request draft open/i);
    assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore, "the WTB draft must be untouched");
  });
}

test("a bare market command still uses listing context, and prose forms are not read as references", async () => {
  const phone = freshPhone();
  await makeListing(phone, "FS", "116500LN", 30000);
  const briefing = await handleIncomingMessage(phone, "market briefing");
  assert.match(briefing.messages.join("\n"), /^Your Market Briefing/);
  const pulse = await handleIncomingMessage(phone, "market pulse");
  assert.match(pulse.messages.join("\n"), /Market Pulse — Rolex Daytona 116500LN/);
});

// ---------------------------------------------------------------------------------------------
// 4/5. The full live sequence, including canonical reference scoping
// ---------------------------------------------------------------------------------------------

test("full live sequence: listings, two edits, an untouched draft, a pulse, and a consistent briefing", async () => {
  const phone = freshPhone();
  // A. multiple active listings — two of them the SAME watch stored under both reference forms.
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  const two = await makeListing(phone, "FS", "126610LN", 14000, { model: "Submariner" });
  const three = await makeListing(phone, "WTB", "116500", 25000);

  // B. an unfinished WTB draft.
  const draftBefore = await openBuyDraft(phone);

  // C. "my listings"
  const listed = await handleIncomingMessage(phone, "my listings");
  assert.match(listed.messages.join("\n"), /1\. FS — Rolex Daytona 116500LN/);
  assert.match(listed.messages.join("\n"), /2\. FS — Rolex Submariner 126610LN/);

  // D/E. edit listing 1 only.
  await handleIncomingMessage(phone, "edit listing 1 price 2500");
  assert.equal(await priceOf(one.id), 2500);
  assert.equal(await priceOf(two.id), 14000);
  assert.equal(await priceOf(three.id), 25000);

  // F/G. edit listing 2 only, with the number after the field name.
  await handleIncomingMessage(phone, "change price listing 2 to 3500");
  assert.equal(await priceOf(two.id), 3500);
  assert.equal(await priceOf(one.id), 2500);
  assert.equal(await priceOf(three.id), 25000);

  // H. the draft never moved.
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);

  // I/J. a deterministic pulse, not an intake review.
  const pulse = await handleIncomingMessage(phone, "market pulse 116500LN");
  const pulseText = pulse.messages.join("\n");
  assert.match(pulseText, /Market Pulse — 116500LN/);
  assert.doesNotMatch(pulseText, /listing review/i);
  assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);

  // K/L. the briefing must scope 116500 and 116500LN to the same canonical bucket, so the FS
  // listing and the WTB request for the same watch report identical market numbers.
  const briefing = await handleIncomingMessage(phone, "market briefing");
  const cards = briefing.messages.join("\n").split(/\n\n(?=\d+\. )/);
  const daytonaFs = cards.find((c) => /^1\. FS/.test(c))!;
  const daytonaWtb = cards.find((c) => /^3\. WTB/.test(c))!;
  const numbers = (card: string) => card.replace(/^\d+\. (?:FS|WTB) — /, "").split("\n").slice(1).join("\n");

  assert.match(daytonaFs, /^1\. FS — Rolex Daytona 116500LN/);
  assert.match(daytonaWtb, /^3\. WTB — Rolex Daytona 116500LN/, "the shorthand form is displayed canonically");
  assert.equal(numbers(daytonaWtb), numbers(daytonaFs), "the same watch must report the same market numbers");
  assert.match(daytonaFs, /Current FS: 1\nCurrent WTB: 1\nAvg FS ask: \$2,500/);

  // The other watch keeps its own, different bucket.
  const submariner = cards.find((c) => /^2\. FS/.test(c))!;
  assert.match(submariner, /Current FS: 1\nCurrent WTB: 0\nAvg FS ask: \$3,500/);
});

/**
 * Ported from codex/continue-stabilization-branch-tasks (08d16e1), whose own listing-edit parser
 * is superseded by the grammar above but which carried two things this branch lacked: correcting
 * a mistyped reference in place, and enforcing ownership in the UPDATE rather than only in the
 * lookup that found the row.
 */
test("a mistyped reference can be corrected in place, in any of the supported phrasings", async () => {
  for (const command of ["edit listing 1 reference 126500LN", "change listing 1 ref to 126500LN", "listing 1 reference 126500LN"]) {
    const phone = freshPhone();
    const one = await makeListing(phone, "FS", "116500LN", 30000);
    const draftBefore = await openBuyDraft(phone);

    const reply = await handleIncomingMessage(phone, command);
    assert.match(reply.messages.join("\n"), /Updated:/, `"${command}" was not recognized`);
    const row = await store.getPosting(one.id);
    assert.equal(row?.reference, "126500LN");
    assert.equal(Number(row?.price), 30000, "correcting identity must not touch price");
    assert.equal(JSON.stringify(getState(phone).pendingBuyIntake), draftBefore);
  }
});

test("a price typed into the reference field is refused rather than stored as identity", async () => {
  const phone = freshPhone();
  const one = await makeListing(phone, "FS", "116500LN", 30000);
  await handleIncomingMessage(phone, "edit listing 1 reference 28500");
  assert.equal((await store.getPosting(one.id))?.reference, "116500LN", "the reference must be unchanged");
});

test("a listing edit cannot reach another account's posting", async () => {
  const owner = freshPhone();
  const other = freshPhone();
  const theirs = await makeListing(other, "FS", "126610LN", 14000);
  const mine = await makeListing(owner, "FS", "116500LN", 30000);

  // The owner's "listing 1" is their own row, never the other account's.
  await handleIncomingMessage(owner, "edit listing 1 price 2500");
  assert.equal(Number((await store.getPosting(mine.id))?.price), 2500);
  assert.equal(Number((await store.getPosting(theirs.id))?.price), 14000, "another account's listing must be untouched");

  // And the UPDATE itself refuses a row the user does not own, not just the lookup.
  const userId = await require("../postings/identity").getOrCreateCanonicalUser("telegram", owner);
  const blocked = await store.updatePostingField(theirs.id, "price", 999, userId);
  assert.equal(blocked, null, "an id from elsewhere must not update another account's listing");
  assert.equal(Number((await store.getPosting(theirs.id))?.price), 14000);
});

test("a WTS message during an open draft asks to replace rather than being swallowed", async () => {
  const phone = freshPhone();
  await openBuyDraft(phone);
  const reply = await handleIncomingMessage(phone, "WTS Rolex 126610LN, 14000");
  assert.match(reply.messages.join("\n"), /replace it or add another/i);
});

test("required regression: \"let change location to USA\" edits the seller's single active listing in place instead of falling through and creating a duplicate", async () => {
  const phone = freshPhone();
  const listing = await makeListing(phone, "FS", "116500LN", 24500, { location: "Miami" });

  const reply = await handleIncomingMessage(phone, "let change location to USA");
  assert.match(reply.messages.join("\n"), /Updated:/i);
  assert.doesNotMatch(reply.messages.join("\n"), /Try "buy:/i, "must not fall through to the generic help text");

  const updated = await store.getPosting(listing.id);
  assert.equal(updated?.location, "USA");
  assert.equal(updated?.status, "active", "editing in place, never closing and re-creating");

  const all = await store.getActivePostingsForUser(listing.canonical_user_id!);
  assert.equal(all.length, 1, "must not create a second listing");
});

test("required regression: index-less location/price/dial edit shortcuts also tolerate \"let\"/\"let's\"/\"let me\" lead-ins", async () => {
  for (const [text, check] of [
    ["let's change my location to Dallas", async (id: number) => assert.equal((await store.getPosting(id))?.location, "Dallas")],
    ["let me change my price to 26000", async (id: number) => assert.equal(Number((await store.getPosting(id))?.price), 26000)],
  ] as const) {
    const phone = freshPhone();
    const listing = await makeListing(phone, "FS", "116500LN", 24500, { location: "Miami" });
    const reply = await handleIncomingMessage(phone, text);
    assert.match(reply.messages.join("\n"), /Updated:/i, `"${text}" should be recognized as an edit`);
    await check(listing.id);
  }
});
