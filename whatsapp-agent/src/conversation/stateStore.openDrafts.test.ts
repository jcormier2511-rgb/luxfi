import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-open-drafts-test-"));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getState, saveState, resetState, listOpenDrafts } = require("./stateStore") as typeof import("./stateStore");

let counter = 0;
const freshPhone = () => `1555${String(++counter).padStart(7, "0")}`;

/**
 * A draft (pendingBuyIntake/pendingSellIntake) lives only in this per-phone conversation state
 * and never in postings, so until now nobody but the customer themselves could see it -- an
 * admin chasing the recurring "I kept your request draft open" reports had no way to see which
 * identities actually had one open, or what was in it.
 */
test("required: listOpenDrafts surfaces a phone with an open buy draft, with its key fields", () => {
  const phone = freshPhone();
  resetState(phone);
  const state = getState(phone);
  state.pendingBuyIntake = { step: "budget", description: "WTB Rolex Daytona", reference: "116500LN", brand: "rolex", model: "Daytona" };
  saveState(state);

  const drafts = listOpenDrafts();
  const row = drafts.find((d) => d.phone === phone);
  assert.ok(row, "the phone with an open draft must appear");
  assert.equal(row!.type, "WTB");
  assert.equal(row!.step, "budget");
  assert.equal(row!.reference, "116500LN");
  assert.equal(row!.brand, "rolex");
});

test("required: listOpenDrafts surfaces a sell draft as FS, distinct from a buy draft as WTB", () => {
  const phone = freshPhone();
  resetState(phone);
  const state = getState(phone);
  state.pendingSellIntake = { step: "price", description: "FS Omega Speedmaster", reference: null };
  saveState(state);

  const row = listOpenDrafts().find((d) => d.phone === phone);
  assert.ok(row);
  assert.equal(row!.type, "FS");
  assert.equal(row!.step, "price");
  assert.equal(row!.reference, null);
});

test("a phone with no open draft never appears, and a confirmed/cleared draft disappears", () => {
  const phone = freshPhone();
  resetState(phone);
  assert.equal(listOpenDrafts().some((d) => d.phone === phone), false, "a phone that never opened a draft must not appear");

  const state = getState(phone);
  state.pendingBuyIntake = { step: "confirm", description: "WTB Rolex", reference: null };
  saveState(state);
  assert.equal(listOpenDrafts().some((d) => d.phone === phone), true, "precondition: the draft is now open");

  state.pendingBuyIntake = undefined;
  saveState(state);
  assert.equal(listOpenDrafts().some((d) => d.phone === phone), false, "a cleared/confirmed draft must disappear from the list");
});

test("a phone with BOTH an open buy draft and an open sell draft appears once for each", () => {
  const phone = freshPhone();
  resetState(phone);
  const state = getState(phone);
  state.pendingBuyIntake = { step: "details", description: "WTB something", reference: null };
  state.pendingSellIntake = { step: "details", description: "FS something else", reference: null };
  saveState(state);

  const rows = listOpenDrafts().filter((d) => d.phone === phone);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.type).sort(), ["FS", "WTB"]);
});
