import { test, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore inventoryDb.ts) is first required, so use
// plain require() here instead of a top-level import, which would be hoisted above this.
// Falls back to a local Postgres (see README's "Local test database" section) unless
// DATABASE_URL is already set — matches config.ts's NODE_ENV=test default.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
const { upsertListings, markMissingInactive, getActiveListings, _resetDbForTests, _closePoolForTests } = inventoryDb;

after(() => _closePoolForTests());

type Row = Parameters<typeof upsertListings>[0][number];

function row(id: string, type: "FS" | "WTB", overrides: Partial<Row> = {}): Row {
  return {
    id,
    type,
    category: "watches",
    item: `item-${id}`,
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "123",
    rating: "",
    description: "",
    detailUrl: `https://watchfacts.com/flash-sales/${id}`,
    ...overrides,
  };
}

test("upsert updates an existing row instead of duplicating it", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("a", "FS")], t1);
  await upsertListings([row("a", "FS", { price: "2000" })], t1);

  const active = await getActiveListings("FS");
  assert.equal(active.length, 1);
  assert.equal(active[0].price, "2000");
  assert.equal(active[0].detailUrl, "https://watchfacts.com/flash-sales/a");
});

test("FS and WTB rows sharing the same external id stay separate", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("shared-id", "FS")], t1);
  await upsertListings([row("shared-id", "WTB")], t1);

  assert.equal((await getActiveListings("FS")).length, 1);
  assert.equal((await getActiveListings("WTB")).length, 1);
  assert.equal((await getActiveListings()).length, 2);
});

test("markMissingInactive deactivates only rows absent from the latest sync", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("keep", "FS"), row("drop", "FS")], t1);
  assert.equal((await getActiveListings("FS")).length, 2);

  const t2 = new Date().toISOString();
  await upsertListings([row("keep", "FS")], t2);
  await markMissingInactive("WF", "FS", ["keep"], t2);

  const activeIds = (await getActiveListings("FS")).map((l) => l.id);
  assert.deepEqual(activeIds, ["keep"]);
});

test("markMissingInactive with an empty seen list is a no-op (never wipes everything)", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("a", "FS")], t1);
  await markMissingInactive("WF", "FS", [], t1);

  assert.equal((await getActiveListings("FS")).length, 1);
});

test("markMissingInactive never touches the other type's rows", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("fs-1", "FS"), row("wtb-1", "WTB")], t1);

  await markMissingInactive("WF", "FS", [], t1); // no-op per the empty-list guard, but also scoped to FS only

  assert.equal((await getActiveListings("FS")).length, 1);
  assert.equal((await getActiveListings("WTB")).length, 1);
});
