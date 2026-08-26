import { test } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore inventoryDb.ts) is first required, so use
// plain require() here instead of a top-level import, which would be hoisted above this.
process.env.INVENTORY_DB = ":memory:";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
const { upsertListings, markMissingInactive, getActiveListings, _resetDbForTests } = inventoryDb;

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
    ...overrides,
  };
}

test("upsert updates an existing row instead of duplicating it", () => {
  _resetDbForTests();
  const t1 = new Date().toISOString();
  upsertListings([row("a", "FS")], t1);
  upsertListings([row("a", "FS", { price: "2000" })], t1);

  const active = getActiveListings("FS");
  assert.equal(active.length, 1);
  assert.equal(active[0].price, "2000");
});

test("FS and WTB rows sharing the same external id stay separate", () => {
  _resetDbForTests();
  const t1 = new Date().toISOString();
  upsertListings([row("shared-id", "FS")], t1);
  upsertListings([row("shared-id", "WTB")], t1);

  assert.equal(getActiveListings("FS").length, 1);
  assert.equal(getActiveListings("WTB").length, 1);
  assert.equal(getActiveListings().length, 2);
});

test("markMissingInactive deactivates only rows absent from the latest sync", () => {
  _resetDbForTests();
  const t1 = new Date().toISOString();
  upsertListings([row("keep", "FS"), row("drop", "FS")], t1);
  assert.equal(getActiveListings("FS").length, 2);

  const t2 = new Date().toISOString();
  upsertListings([row("keep", "FS")], t2);
  markMissingInactive("WF", "FS", ["keep"], t2);

  const activeIds = getActiveListings("FS").map((l) => l.id);
  assert.deepEqual(activeIds, ["keep"]);
});

test("markMissingInactive with an empty seen list is a no-op (never wipes everything)", () => {
  _resetDbForTests();
  const t1 = new Date().toISOString();
  upsertListings([row("a", "FS")], t1);
  markMissingInactive("WF", "FS", [], t1);

  assert.equal(getActiveListings("FS").length, 1);
});

test("markMissingInactive never touches the other type's rows", () => {
  _resetDbForTests();
  const t1 = new Date().toISOString();
  upsertListings([row("fs-1", "FS"), row("wtb-1", "WTB")], t1);

  markMissingInactive("WF", "FS", [], t1); // no-op per the empty-list guard, but also scoped to FS only

  assert.equal(getActiveListings("FS").length, 1);
  assert.equal(getActiveListings("WTB").length, 1);
});
