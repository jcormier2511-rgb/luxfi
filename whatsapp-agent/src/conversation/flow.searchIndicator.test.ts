import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Real reported ask: "If the system takes more than 2 seconds to respond while searching, it
 * would be helpful to show a typing or loading indicator so the user knows the search is still
 * in progress and doesn't think the system stopped working." The webhook handler only ever sends
 * the messages handleIncomingMessage returns AFTER it fully resolves, so the indicator is fired
 * as its own proactive send mid-flow (see flow.ts's withSearchIndicator) rather than through the
 * normal return path -- these tests mock the underlying search call to control exactly how long
 * it appears to take, and the outbound send to observe what actually went out and when.
 */
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-searchindicator-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const greenApiClient = require("../channels/greenApi") as typeof import("../channels/greenApi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("../matching/engine") as typeof import("../matching/engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

const INDICATOR = /still searching and loading/i;

// A first-time contact's search is preceded by a one-time price/location/dial/condition
// interview (see flow.ts's handlePreferenceAnswer) -- the actual search, and so the actual
// findMatchesHybrid call, only runs once that's answered. Mirrors the exact sequence
// flow.taskCompletionFallback.test.ts already uses to reach a live search.
async function reachSearch(phone: string): Promise<void> {
  resetState(phone);
  await handleIncomingMessage(phone, "hi");
  await handleIncomingMessage(phone, "buy: Rolex Daytona 116500LN");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
  await handleIncomingMessage(phone, "any");
}

test("required regression: a search that resolves quickly never sends a proactive search indicator", async (t) => {
  const sent: string[] = [];
  t.mock.method(greenApiClient, "sendText", async (_phone: string, message: string) => {
    sent.push(message);
  });
  let called = false;
  t.mock.method(engine, "findMatchesHybrid", async () => {
    called = true;
    return [];
  });

  const phone = "19990004001";
  await reachSearch(phone);
  const result = await handleIncomingMessage(phone, "any"); // the 4th answer actually runs the search

  assert.ok(called, "precondition: the search must actually have run");
  assert.match(result.messages.join("\n"), /No live matches yet/);
  assert.deepEqual(sent, [], "a fast search must never trigger the 'still searching' proactive send");
});

test('required regression: a search still running after 2 seconds sends a proactive "still searching" indicator before the results', async (t) => {
  const sent: string[] = [];
  t.mock.method(greenApiClient, "sendText", async (_phone: string, message: string) => {
    sent.push(message);
  });

  let resolveSearch!: (listings: Awaited<ReturnType<typeof engine.findMatchesHybrid>>) => void;
  const slowSearch = new Promise<Awaited<ReturnType<typeof engine.findMatchesHybrid>>>((resolve) => {
    resolveSearch = resolve;
  });
  t.mock.method(engine, "findMatchesHybrid", async () => slowSearch);

  const phone = "19990004002";
  await reachSearch(phone);
  const searchPromise = handleIncomingMessage(phone, "any"); // the 4th answer actually runs the search

  // Real wait, deliberately just past the 2s threshold — the indicator fires off its own
  // setTimeout independent of the search promise, so there's no synchronous hook to await instead.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.ok(sent.some((m) => INDICATOR.test(m)), "the indicator must have fired while the search was still pending");
  assert.equal(sent.length, 1, "must fire exactly once, not repeatedly, while still pending");

  resolveSearch([]);
  const result = await searchPromise;
  assert.match(
    result.messages.join("\n"),
    /No live matches yet/,
    "the real result must still arrive normally once the slow search actually finishes"
  );
});
