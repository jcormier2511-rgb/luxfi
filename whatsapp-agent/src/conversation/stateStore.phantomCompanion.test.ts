import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-phantom-companion-test-"));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isSuspectedPhantomCompanion, _resetPhantomCompanionForTests } = require("./stateStore") as typeof import("./stateStore");

beforeEach(() => {
  _resetPhantomCompanionForTests();
});

/**
 * Real reported bug, still not fully root-caused: every genuine WhatsApp text message is
 * followed by a SECOND webhook delivery -- same phone, same instant, a different id, with no
 * text and no image -- confirmed via production [whapi] raw logs. This is the stopgap that
 * suppresses that companion until the exact message `type` it carries is identified.
 */
test("required regression: a content-less message arriving right after a real one from the same phone is flagged as a suspected phantom companion", () => {
  assert.equal(isSuspectedPhantomCompanion("15551234567", "Hi, I want to join LuxFi network"), false, "the real message itself is never flagged");
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), true, "an empty companion right after it is the exact observed pattern");
});

test("a content-less message with no preceding real message is never flagged -- id-based dedup alone applies to those", () => {
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), false);
});

test("two different phones never interfere with each other", () => {
  isSuspectedPhantomCompanion("15551234567", "hi");
  assert.equal(isSuspectedPhantomCompanion("15559876543", "", undefined), false, "a content-less message from a DIFFERENT phone must never be blamed on someone else's real message");
});

test("a content-less message with an image is never flagged -- an uncaptioned photo reply is real content, not a phantom", () => {
  isSuspectedPhantomCompanion("15551234567", "please send photos");
  assert.equal(isSuspectedPhantomCompanion("15551234567", "", "https://cdn.example/a.jpg"), false);
});

test("the phantom window expires -- a genuinely separate content-less message sent well after is not flagged", async () => {
  isSuspectedPhantomCompanion("15551234567", "hi");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10_000;
    assert.equal(isSuspectedPhantomCompanion("15551234567", "", undefined), false, "well outside the window, a content-less message is treated as its own genuine message");
  } finally {
    Date.now = realNow;
  }
});
