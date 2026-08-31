import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-listing-flow-"));
process.env.PERSIST_DIR = dir;
process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

// Loaded after env setup so state is isolated and deterministic.
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function workflowQuestions(messages: string[]): string[] {
  return messages.filter((m) => /\?/.test(m));
}

test('FS shorthand preserves reference and bare asking price, with intro before one missing-field question', async () => {
  const phone = "15550001001";
  resetState(phone);
  const result = await handleIncomingMessage(phone, "FS Rolex 116500LN 28500");

  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0], /Fi/i, "onboarding must be the first message");
  assert.match(result.messages[1], /condition/i);
  assert.equal(workflowQuestions(result.messages).length, 1);
  assert.equal(result.state.pendingSellIntake?.reference, "116500LN");
  assert.equal(result.state.pendingSellIntake?.price, 28500);
  assert.doesNotMatch(result.messages.join("\n"), /price range|asking price|searching now|external WTB feed|feature.flag/i);

  const next = await handleIncomingMessage(phone, "pre-owned");
  assert.deepEqual(workflowQuestions(next.messages).length, 1);
  assert.match(next.messages[0], /located/i);
  assert.equal(next.state.pendingSellIntake?.price, 28500, "an answer must not overwrite parsed price");
  assert.equal(next.state.pendingSellIntake?.reference, "116500LN", "an answer must not overwrite parsed reference");
});

test('WTB shorthand preserves budget/reference and asks one buyer question per turn without replaying onboarding', async () => {
  const phone = "15550001002";
  resetState(phone);
  const first = await handleIncomingMessage(phone, "WTB Rolex 116500LN under 25k");

  assert.match(first.messages[0], /Fi/i);
  assert.match(first.messages[1], /condition.*prefer/i);
  assert.equal(workflowQuestions(first.messages).length, 1);
  assert.equal(first.state.pendingBuyIntake?.budget, 25000);
  assert.equal(first.state.pendingBuyIntake?.reference, "116500LN");
  assert.doesNotMatch(first.messages.join("\n"), /searching now|external .* disabled|feature.flag/i);

  const second = await handleIncomingMessage(phone, "any");
  assert.equal(second.messages.length, 1, "onboarding and prior questions must not be replayed");
  assert.match(second.messages[0], /location preference/i);
  assert.equal(workflowQuestions(second.messages).length, 1);
  assert.equal(second.state.pendingBuyIntake?.budget, 25000);
  assert.equal(second.state.pendingBuyIntake?.reference, "116500LN");
});
