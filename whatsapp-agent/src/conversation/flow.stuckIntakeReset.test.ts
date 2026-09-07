import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Real reported pattern this session: a stuck or confused conversation kept getting the exact
 * same non-advancing "I kept your ... draft open" reply over and over, with no way out short of
 * an admin manually resetting the account (see admin/tools' new "Open drafts" view). After 3
 * consecutive replies that fail to advance whichever draft is open, Fi now gives up on it rather
 * than repeating itself a fourth time -- clears the draft and reprints the intro instead.
 */
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-stuck-intake-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState, getState } = require("./stateStore") as typeof import("./stateStore");

test("required regression: 3 consecutive non-advancing replies to an open buy draft resets it and reprints the intro, instead of repeating the fallback a 4th time", async () => {
  const phone = "19992240001";
  resetState(phone);

  const started = await handleIncomingMessage(phone, "I need help, can you assist");
  assert.ok(started.state.pendingBuyIntake, "precondition: a draft is now open");

  const first = await handleIncomingMessage(phone, "hmm");
  assert.match(first.messages.join("\n"), /kept your request draft open/);
  assert.doesNotMatch(first.messages.join("\n"), /let's start over/);
  assert.ok(getState(phone).pendingBuyIntake, "the draft survives the first non-advancing reply");

  const second = await handleIncomingMessage(phone, "idk");
  assert.match(second.messages.join("\n"), /kept your request draft open/);
  assert.doesNotMatch(second.messages.join("\n"), /let's start over/);
  assert.ok(getState(phone).pendingBuyIntake, "the draft survives the second non-advancing reply");

  const third = await handleIncomingMessage(phone, "not sure");
  const text = third.messages.join("\n");
  assert.match(text, /let's start over/i);
  assert.match(text, /here's what I can do/i, "the intro/menu is reprinted, not just a bare apology");
  assert.doesNotMatch(text, /kept your request draft open/, "the 3rd time replaces the fallback entirely, it doesn't also send it");
  assert.equal(getState(phone).pendingBuyIntake, undefined, "the stuck draft is cleared");
  assert.equal(getState(phone).intakeFallbackCount, 0, "the counter resets once it fires, so a fresh draft starts clean");
});

test("an answer that actually advances the draft resets the counter -- it does not accumulate across a mix of good and bad replies", async () => {
  const phone = "19992240002";
  resetState(phone);

  await handleIncomingMessage(phone, "I need help, can you assist");
  await handleIncomingMessage(phone, "hmm"); // 1st non-advancing
  await handleIncomingMessage(phone, "idk"); // 2nd non-advancing

  // A real answer (names a brand) advances the draft and must reset the count.
  const advanced = await handleIncomingMessage(phone, "Rolex");
  assert.doesNotMatch(advanced.messages.join("\n"), /kept your request draft open|let's start over/);

  // Two MORE non-advancing replies after that should not yet trip the threshold (count is back
  // to 0, this is only the 2nd in the new streak) -- it would already have fired here if the
  // earlier two had not been reset.
  const again1 = await handleIncomingMessage(phone, "hmm");
  assert.match(again1.messages.join("\n"), /kept your request draft open/);
  assert.doesNotMatch(again1.messages.join("\n"), /let's start over/);
  assert.ok(getState(phone).pendingBuyIntake, "the draft must still be open -- the earlier non-advancing replies must not have carried over");
});

test("a brand-new draft never inherits a stale fallback count from a previous, unrelated draft", async () => {
  const phone = "19992240003";
  resetState(phone);

  await handleIncomingMessage(phone, "I need help, can you assist");
  await handleIncomingMessage(phone, "hmm");
  await handleIncomingMessage(phone, "idk");
  assert.ok(getState(phone).pendingBuyIntake, "precondition: still open after 2 non-advancing replies");

  // Starting a fresh, unrelated, complete request replaces the old draft outright.
  const fresh = await handleIncomingMessage(phone, "WTB Rolex Daytona 116500LN budget $30,000");
  assert.equal(getState(phone).intakeFallbackCount, 0, "a brand-new draft must start with a clean counter");

  // One non-advancing reply to the NEW draft must not immediately trip the threshold as if it
  // were the 3rd in a row from the old draft.
  const reply = await handleIncomingMessage(phone, "hmm");
  assert.doesNotMatch(reply.messages.join("\n"), /let's start over/, "a single non-advancing reply to a fresh draft must never itself trigger the reset");
  assert.ok(fresh.state.pendingBuyIntake, "sanity: the fresh draft did open");
});
