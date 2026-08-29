import { test, after, beforeEach } from "node:test";
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rates = require("../fx/rates") as typeof import("../fx/rates");
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

async function freshSearch(phone: string, query: string): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, query));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
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

test("required regression: a contact's preferred currency changes the converted estimate on Match Cards", async () => {
  rates._setRatesForTests({ base: "USD", rates: { HKD: 7.8, EUR: 0.92 }, fetchedAt: new Date() });
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("eur-pref", { nativePriceAmount: 850000, nativeCurrency: "HKD", originalPriceText: "HK$850,000" })],
    new Date().toISOString()
  );

  await handleIncomingMessage(PHONE_C, "Show prices in EUR");
  const messages = await freshSearch(PHONE_C, "buy: Rolex Daytona 116500LN");
  const card = messages.find((m) => m.includes("Asking:"));
  assert.ok(card, "expected a Match Card in the reply");
  assert.match(card!, /Asking: HK\$850,000 HKD/, "the native price must still be shown unchanged");
  assert.match(card!, /Approximately: €100,256 EUR/, "converts to the contact's preferred EUR, not the default USD");
  assert.doesNotMatch(card!, /USD/, "must not also show a USD figure once a preference is set");
});
