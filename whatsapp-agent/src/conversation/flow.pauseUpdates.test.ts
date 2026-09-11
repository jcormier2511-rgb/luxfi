import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WEBHOOK_TOKEN = "test";

const db = require("../postings/db") as typeof import("../postings/db");
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
const { resetState } = require("./stateStore") as typeof import("./stateStore");
const { getMorningBriefingPauseStatus } = require("../lifecycle") as typeof import("../lifecycle");

after(async () => { await db._closePoolForTests(); });
beforeEach(async () => { await db._resetDbForTests(); });

let counter = 0;
function freshPhone(): string {
  counter += 1;
  const phone = `1555070${String(counter).padStart(4, "0")}`;
  resetState(phone);
  return phone;
}

test('"pause my morning updates" with no duration pauses indefinitely', async () => {
  const phone = freshPhone();
  const reply = await handleIncomingMessage(phone, "pause my morning updates");
  assert.match(reply.messages.join("\n"), /paused indefinitely/i);
  assert.equal(await getMorningBriefingPauseStatus(phone), "indefinite");
});

for (const [phrase, expectedDays] of [
  ["pause my morning updates for a day", 1],
  ["pause updates for 1 week", 7],
  ["pause updates for a month", 30],
] as const) {
  test(`"${phrase}" pauses for the right length of time`, async () => {
    const phone = freshPhone();
    const before = Date.now();
    const reply = await handleIncomingMessage(phone, phrase);
    assert.doesNotMatch(reply.messages.join("\n"), /indefinitely/i);
    const status = await getMorningBriefingPauseStatus(phone);
    assert.ok(status instanceof Date, `expected a concrete end date for "${phrase}"`);
    const deltaDays = ((status as Date).getTime() - before) / 86_400_000;
    assert.ok(Math.abs(deltaDays - expectedDays) < 0.01, `expected ~${expectedDays} days, got ${deltaDays}`);
  });
}

test('"pause updates indefinitely"/"forever"/"permanently" are all recognized as indefinite', async () => {
  for (const phrase of ["pause updates indefinitely", "pause updates forever", "pause my updates permanently"]) {
    const phone = freshPhone();
    await handleIncomingMessage(phone, phrase);
    assert.equal(await getMorningBriefingPauseStatus(phone), "indefinite", `"${phrase}" must pause indefinitely`);
  }
});

test('"resume updates" clears a pause', async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "pause updates");
  assert.equal(await getMorningBriefingPauseStatus(phone), "indefinite");

  const reply = await handleIncomingMessage(phone, "resume updates");
  assert.match(reply.messages.join("\n"), /back on/i);
  assert.equal(await getMorningBriefingPauseStatus(phone), null);
});

test('"are my updates paused?" reports the real status without changing it', async () => {
  const phone = freshPhone();
  const before = await handleIncomingMessage(phone, "are my updates paused?");
  assert.match(before.messages.join("\n"), /nothing paused/i);

  await handleIncomingMessage(phone, "pause updates for a week");
  const statusBefore = await getMorningBriefingPauseStatus(phone);
  const after1 = await handleIncomingMessage(phone, "are my updates paused?");
  assert.match(after1.messages.join("\n"), /paused until/i);
  assert.deepEqual(await getMorningBriefingPauseStatus(phone), statusBefore, "the status query must not itself change anything");
});

// "cancel my membership"/"cancel my plan" were already carved out of the bare CANCEL_COMMAND;
// "pause"/"resume" live in their own separate command family and must never collide with it.
test('a bare "cancel" never touches the morning-updates pause', async () => {
  const phone = freshPhone();
  await handleIncomingMessage(phone, "pause updates for a week");
  await handleIncomingMessage(phone, "cancel");
  assert.notEqual(await getMorningBriefingPauseStatus(phone), null, "an unrelated 'cancel' must not clear the pause");
});
