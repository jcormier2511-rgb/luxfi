import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-engine-pricesignal-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("./engine") as typeof import("./engine");
const { upsertListings, _resetDbForTests, _closePoolForTests } = inventoryDb;
const { attachPriceSignals, formatMatchCard } = engine;

after(async () => {
  await _closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

type Row = Parameters<typeof upsertListings>[0][number];

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "28000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    detailUrl: `https://watchfacts.com/flash-sales/${id}`,
    ...overrides,
  };
}

test("required regression: attachPriceSignals flags a bezel-priced listing as Attractive against its real comps from the DB", async () => {
  await _resetDbForTests();
  await upsertListings(
    [
      row("bezel-bug", { price: "2500" }),
      row("comp-1", { price: "28000" }),
      row("comp-2", { price: "29500" }),
    ],
    new Date().toISOString()
  );

  const target = { listing: { ...row("bezel-bug", { price: "2500" }), source: "WF" } };
  const [signaled] = await attachPriceSignals([target]);
  assert.equal(signaled.priceSignal, "Attractive");
});

test("attachPriceSignals is a no-op (no query) when there are no FS results to signal", async () => {
  await _resetDbForTests();
  const wtbOnly = { listing: { ...row("wtb-1", { type: "WTB" as const }), source: "WF" } };
  const [signaled] = await attachPriceSignals([wtbOnly]);
  assert.equal(signaled.priceSignal, undefined);
});

test("formatMatchCard appends the price signal inline on the price line when present, and omits it when absent", () => {
  const listing = { ...row("card-1", { price: "2500" }), source: "WF" };
  const withSignal = formatMatchCard(listing, 0, "buy", undefined, "Attractive");
  assert.match(withSignal, /\$2,500 \(USD \$2,500\) \(Attractive vs\. comps\)/);

  const withoutSignal = formatMatchCard(listing, 0, "buy");
  assert.doesNotMatch(withoutSignal, /vs\. comps/);
});
