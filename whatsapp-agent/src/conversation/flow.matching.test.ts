import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR — same reasoning as flow.entitlement.test.ts.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-matching-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "",
    ...overrides,
  };
}

/** Walks a fresh contact through the once-per-contact preference questions with "any" each time. */
async function freshSearch(phone: string, query: string): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, query));
  push(await handleIncomingMessage(phone, "any")); // price
  push(await handleIncomingMessage(phone, "any")); // location
  push(await handleIncomingMessage(phone, "any")); // dial
  push(await handleIncomingMessage(phone, "any")); // condition
  return collected;
}

test("required regression: no exact reference available → no results, Fi starts monitoring instead of showing a wrong watch", async () => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona bundle lot" })],
    new Date().toISOString()
  );

  const messages = await freshSearch("19990001111", "buy: Rolex Daytona 116500LN");
  assert.ok(!messages.some((m) => /Potential Match/.test(m)), "must never show a card for a different reference");
  assert.ok(
    messages.some((m) => /No live matches yet/i.test(m) && /keep watching/i.test(m)),
    "must tell the user Fi will keep monitoring instead of going silent or showing something wrong"
  );
});

test('required regression: a price like "under $20000" is never treated as a requested reference', async () => {
  await inventoryDb._resetDbForTests();
  // Note: "$20,000" (with a comma) was never actually at risk — the comma already breaks
  // \d{4,6}'s continuous-digit requirement. "$20000" (no comma) is the real failure case:
  // without the fix, "20000" fits the reference shape exactly like a real 5-digit reference.
  await inventoryDb.upsertListings(
    [fsRow("budget-1", { brand: "Rolex", description: "Rolex Submariner, great condition" })],
    new Date().toISOString()
  );

  const messages = await freshSearch("19990002222", "buy: Rolex under $20000");
  assert.ok(
    messages.some((m) => /Potential Match/.test(m)),
    "treating 20000 as a reference would incorrectly force an exact-match-only search and hide this real listing"
  );
});
