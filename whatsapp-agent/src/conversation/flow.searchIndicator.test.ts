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
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
const PHONE_1 = "19990004001";
const PHONE_2 = "19990004002";
process.env.AI_MATCHING_TEST_PHONE = `${PHONE_1},${PHONE_2}`;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const greenApiClient = require("../channels/whatsappCloud") as typeof import("../channels/whatsappCloud");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("../matching/engine") as typeof import("../matching/engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fulfillmentService = require("../fulfillment/service") as typeof import("../fulfillment/service");
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
const SEARCH_TEXT = "looking for a Rolex Daytona 116500LN";

/** A complete, confident buy intent -- every preference already present, so the search runs
 *  immediately with no follow-up question in the way (that mechanism is covered elsewhere, e.g.
 *  flow.naturalFollowUp.test.ts; these tests are purely about the search-indicator's timing). */
function confidentBuyIntent() {
  return {
    intent: {
      intent: "buy" as const,
      brand: "Rolex",
      model: "Daytona",
      reference: "116500LN",
      dial: "any",
      condition: "any",
      year: null,
      boxPapers: null,
      priceMin: null,
      priceMax: 500000,
      currency: "USD",
      location: "North America",
      searchText: "Rolex Daytona 116500LN",
      confidence: 0.9,
    },
    priceUnreliable: false,
  };
}

/** Only the AI-matching test phone still reaches findMatchesHybrid via startSearch (see
 *  conversation/flow.ts's resolveItemRequests) -- the `buy:`/`sell:` command now creates a
 *  monitored posting like any other conversational request, same as everyone else. */
async function reachSearch(phone: string): Promise<void> {
  resetState(phone);
  await handleIncomingMessage(phone, "hi");
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
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) => (/rolex daytona/i.test(text) ? confidentBuyIntent() : null));

  const phone = PHONE_1;
  await reachSearch(phone);
  const result = await handleIncomingMessage(phone, SEARCH_TEXT);

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
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) => (/rolex daytona/i.test(text) ? confidentBuyIntent() : null));

  const phone = PHONE_2;
  await reachSearch(phone);
  const searchPromise = handleIncomingMessage(phone, SEARCH_TEXT);

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

/**
 * Real reported gap: the confirm-time match search for an ordinary WTB/FS conversational intake
 * (ingestDirectBuyPosting/ingestDirectSellPosting, via fulfillment/service.ts's fulfillWtb) never
 * had the search indicator wired in at all -- only the old v3 startSearch path and the Market
 * Pulse commands did. A slow confirm-time search (many candidates to score) looked identical to
 * Fi having stopped responding, the exact complaint the indicator exists to prevent.
 */
test('required regression: confirming a WTB whose match search takes over 2 seconds shows the "still searching" indicator', async (t) => {
  const sent: string[] = [];
  t.mock.method(greenApiClient, "sendText", async (_phone: string, message: string) => {
    sent.push(message);
  });

  let resolveFulfill!: (result: Awaited<ReturnType<typeof fulfillmentService.fulfillWtb>>) => void;
  const slowFulfill = new Promise<Awaited<ReturnType<typeof fulfillmentService.fulfillWtb>>>((resolve) => {
    resolveFulfill = resolve;
  });
  t.mock.method(fulfillmentService, "fulfillWtb", async () => slowFulfill);

  const phone = "19990004010";
  resetState(phone);
  await handleIncomingMessage(phone, "WTB Rolex Daytona 116500LN black dial pre-owned Miami max $35,000");
  const confirmPromise = handleIncomingMessage(phone, "confirm");

  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.ok(sent.some((m) => INDICATOR.test(m)), "the indicator must fire while the confirm-time match search is still pending");

  resolveFulfill({ explicitMatches: 0, opportunities: 0, pendingNotifications: [] });
  const result = await confirmPromise;
  assert.match(result.messages.join("\n"), /WTB request is active/, "the real confirmation must still arrive normally once the slow search actually finishes");
});
