import { test, after, beforeEach, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-currencypref-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.OPEN_EXCHANGE_RATES_APP_ID = "test-app-id";
process.env.FX_MAX_STALENESS_HOURS = "24";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "17775553003";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rates = require("../fx/rates") as typeof import("../fx/rates");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

beforeEach(() => {
  rates._resetRatesForTests();
});

const PHONE_A = "17775553001";
const PHONE_B = "17775553002";
const PHONE_C = "17775553003";

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "ASK",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    ...overrides,
  };
}

/** Drives the AI-matching-test-phone ephemeral search path -- the replacement for the old
 *  "buy: X" + a few "any" replies shortcut, which no longer reaches a v3 search at all (see
 *  conversation/flow.ts: `buy:`/`sell:` now creates a monitored posting like any other
 *  conversational request). A confident, fully-specified intent means the search runs
 *  immediately with no follow-up question in the way. */
async function freshSearch(t: TestContext, phone: string): Promise<string[]> {
  t.mock.method(intentExtractorModule, "extractIntent", async () => ({
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
      location: "Global",
      searchText: "Rolex Daytona 116500LN",
      confidence: 0.9,
    },
    priceUnreliable: false,
  }));
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, "looking for a Rolex Daytona 116500LN"));
  return collected;
}

test("required: 'Show prices in EUR' is accepted and confirmed", async () => {
  const result = await handleIncomingMessage(PHONE_A, "Show prices in EUR");
  assert.equal(result.state.preferredDisplayCurrency, "EUR");
  assert.match(result.messages.join("\n"), /EUR/);
});

test("required: 'Use HKD as my preferred currency' is accepted and confirmed", async () => {
  const result = await handleIncomingMessage(PHONE_A, "Use HKD as my preferred currency");
  assert.equal(result.state.preferredDisplayCurrency, "HKD");
  assert.match(result.messages.join("\n"), /HKD/);
});

test("an unrecognized currency code is rejected rather than silently stored", async () => {
  const result = await handleIncomingMessage(PHONE_B, "Show prices in ZZZ");
  assert.equal(result.state.preferredDisplayCurrency, undefined);
  assert.match(result.messages.join("\n"), /don't recognize/i);
});

test("required regression: a contact's preferred currency changes the converted estimate on Match Cards", async (t) => {
  rates._setRatesForTests({ base: "USD", rates: { HKD: 7.8, EUR: 0.92 }, fetchedAt: new Date() });
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("eur-pref", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" })],
    new Date().toISOString()
  );

  await handleIncomingMessage(PHONE_C, "Show prices in EUR");
  const messages = await freshSearch(t, PHONE_C);
  const card = messages.find((m) => m.includes("Asking:"));
  assert.ok(card, "expected a Match Card in the reply");
  assert.match(card!, /Asking: HK\$850,000 HKD/, "the native price must still be shown unchanged");
  assert.match(card!, /Approximately: €100,256 EUR/, "converts to the contact's preferred EUR, not the default USD");
  assert.doesNotMatch(card!, /USD/, "must not also show a USD figure once a preference is set");
});
