import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-content-dedupe-test-"));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { alreadyProcessedContent, _resetContentDedupeForTests } = require("./stateStore") as typeof import("./stateStore");

beforeEach(() => {
  _resetContentDedupeForTests();
});

test("required regression: the same phone repeating the same text within the window is a duplicate", () => {
  assert.equal(alreadyProcessedContent("15551234567", "hi"), false, "the first sighting is never a duplicate");
  assert.equal(alreadyProcessedContent("15551234567", "hi"), true, "an immediate repeat is exactly the WhatsApp multi-device / provider-retry pattern this guards against");
});

test("a repeat is case/whitespace-insensitive, matching how the same text is compared everywhere else", () => {
  assert.equal(alreadyProcessedContent("15551234567", "Hi"), false);
  assert.equal(alreadyProcessedContent("15551234567", "  hi  "), true, "the same message re-delivered with different incidental casing/whitespace is still the same duplicate");
});

test("two different phones sending the identical text never collide -- e.g. two different people typing \"yes\" in a group", () => {
  assert.equal(alreadyProcessedContent("15551234567", "yes"), false);
  assert.equal(alreadyProcessedContent("15559876543", "yes"), false, "a different sender's identical text is a real, distinct message");
});

test("the same phone sending genuinely different text is never treated as a duplicate", () => {
  assert.equal(alreadyProcessedContent("15551234567", "hi"), false);
  assert.equal(alreadyProcessedContent("15551234567", "buy: Rolex Daytona"), false, "a different message from the same phone must always get through");
});

test("two different images with no caption never collide, even though both carry empty text", () => {
  assert.equal(alreadyProcessedContent("15551234567", "", "https://cdn.example/a.jpg"), false);
  assert.equal(alreadyProcessedContent("15551234567", "", "https://cdn.example/b.jpg"), false, "a second, different photo must never be swallowed as a duplicate of the first");
});

test("a genuinely content-less message (no text, no image -- e.g. a bare document) is never deduped by content, only by id", () => {
  assert.equal(alreadyProcessedContent("15551234567", ""), false);
  assert.equal(alreadyProcessedContent("15551234567", ""), false, "two real, distinct content-less messages would otherwise collide on the same empty key");
});

test("the dedup window expires -- a genuinely repeated message sent long after is treated as new, not swallowed forever", async () => {
  assert.equal(alreadyProcessedContent("15551234567", "hi"), false);
  assert.equal(alreadyProcessedContent("15551234567", "hi"), true);
  // Simulate the window elapsing without an actual multi-second sleep in the test run.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6_000;
    assert.equal(alreadyProcessedContent("15551234567", "hi"), false, "past the dedup window, a repeat is a real, separate message (e.g. an impatient user resending)");
  } finally {
    Date.now = realNow;
  }
});
