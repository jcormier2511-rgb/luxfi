import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

// Must be set before config.ts (and therefore inventoryDb.ts) is first required, so use
// plain require() here instead of a top-level import, which would be hoisted above this.
// Falls back to a local Postgres (see README's "Local test database" section) unless
// DATABASE_URL is already set — matches config.ts's NODE_ENV=test default.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./inventoryDb") as typeof import("./inventoryDb");
const {
  upsertListings,
  markMissingInactive,
  getActiveListings,
  getSyncStatus,
  recordTypeSyncSuccess,
  recordTypeSyncError,
  searchListingsForDiagnostics,
  _forceSchemaRecheckForTests,
  _resetDbForTests,
  _closePoolForTests,
} = inventoryDb;

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

test("searchListingsForDiagnostics finds a match by ref, item, or description, including inactive rows", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("a", "FS", { ref: "116500LN" })], t1);
  await upsertListings([row("b", "FS", { ref: "", item: "mentions 116500LN in title" })], t1);
  await upsertListings([row("c", "FS", { ref: "999999" })], t1);
  await markMissingInactive("WF", "FS", ["b", "c"], t1); // marks "a" inactive

  const results = await searchListingsForDiagnostics("116500");
  const ids = results.map((r) => r.externalId).sort();
  assert.deepEqual(ids, ["a", "b"], "must match by ref OR item text, and must not exclude inactive rows");
  const a = results.find((r) => r.externalId === "a")!;
  assert.equal(a.isActive, false, "diagnostics must surface inactive status, not hide it");
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

test("FS and WTB sync status are tracked independently — a WTB error never touches FS's status", async () => {
  await _resetDbForTests();
  await recordTypeSyncSuccess("FS");
  await recordTypeSyncError("WTB", "Could not find a working auction_type value for WTB");

  const status = await getSyncStatus(true);
  assert.ok(status.fs.lastSuccessAt, "FS should show a successful sync");
  assert.equal(status.fs.lastError, null, "FS error should be unaffected by WTB's failure");
  assert.equal(status.wtb.lastSuccessAt, null, "WTB never succeeded");
  assert.match(status.wtb.lastError ?? "", /auction_type/);
});

test("recordTypeSyncSuccess clears a previously recorded error for that type only", async () => {
  await _resetDbForTests();
  await recordTypeSyncError("FS", "transient failure");
  await recordTypeSyncError("WTB", "transient failure");
  await recordTypeSyncSuccess("FS");

  const status = await getSyncStatus(true);
  assert.equal(status.fs.lastError, null);
  assert.equal(status.wtb.lastError, "transient failure");
});

test("getSyncStatus reports active counts per type from real DB state, not from sync_meta", async () => {
  await _resetDbForTests();
  const t1 = new Date().toISOString();
  await upsertListings([row("fs-1", "FS"), row("fs-2", "FS"), row("wtb-1", "WTB")], t1);

  const status = await getSyncStatus(true);
  assert.equal(status.fs.activeCount, 2);
  assert.equal(status.wtb.activeCount, 1);
  assert.equal(status.totalActiveCount, 3);
});

test("migration keeps the previous version's legacy sync_meta columns and backfills the new per-type fields from them", async () => {
  await _resetDbForTests();

  // Simulate a table left behind by the previously deployed version — old shared columns
  // only, no per-type ones — set up via a raw client, bypassing this version's own schema.
  const rawPool = new Pool({ connectionString: config.database.url });
  try {
    await rawPool.query(`DROP TABLE IF EXISTS sync_meta`);
    await rawPool.query(`
      CREATE TABLE sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_success_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        fs_count INTEGER NOT NULL DEFAULT 0,
        wtb_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await rawPool.query(
      `INSERT INTO sync_meta (id, last_success_at, last_error, fs_count, wtb_count) VALUES (1, $1, $2, 20, 5)`,
      ["2026-01-01T00:00:00.000Z", "old shared error"]
    );

    // Force this version's migration to actually run against the table as it exists right
    // now (a plain getSyncStatus(true) call would otherwise reuse the already-resolved schema
    // check from _resetDbForTests() above and skip re-running the migration SQL).
    _forceSchemaRecheckForTests();
    const status = await getSyncStatus(true);

    // The previous version's columns must still be there and queryable — proves a Railway
    // rollback to that version wouldn't crash against this same, now-migrated-forward table.
    const legacy = await rawPool.query(
      `SELECT last_success_at, last_error, fs_count, wtb_count FROM sync_meta WHERE id = 1`
    );
    assert.equal(legacy.rows[0].fs_count, 20);
    assert.equal(legacy.rows[0].wtb_count, 5);
    assert.equal(legacy.rows[0].last_error, "old shared error");
    assert.ok(legacy.rows[0].last_success_at);

    // Backfill: since the old schema had one shared status for both sides, the new per-type
    // fields should be seeded from it on first migration.
    assert.ok(status.fs.lastSuccessAt);
    assert.ok(status.wtb.lastSuccessAt);
    assert.equal(status.fs.lastError, "old shared error");
    assert.equal(status.wtb.lastError, "old shared error");
  } finally {
    await rawPool.end();
  }
});

test("migration backfill never overwrites a real per-type value already written by this version", async () => {
  await _resetDbForTests();
  await recordTypeSyncSuccess("FS"); // real, current-version value
  const realFsSuccess = (await getSyncStatus(true)).fs.lastSuccessAt;

  // Re-running the migration (as happens on every boot) must not clobber it with a backfill.
  _forceSchemaRecheckForTests();
  const status = await getSyncStatus(true);
  assert.equal(status.fs.lastSuccessAt, realFsSuccess);
});

test("getSyncStatus(false) reports WTB as disabled, not as an error, even with a stale error sitting in the DB", async () => {
  await _resetDbForTests();
  await recordTypeSyncSuccess("FS");
  await recordTypeSyncError("WTB", "Could not find a working auction_type value for WTB");
  await upsertListings([row("wtb-1", "WTB")], new Date().toISOString());

  const status = await getSyncStatus(false);
  assert.equal(status.wtb.status, "disabled");
  assert.equal(status.wtb.lastError, null, "a stale WTB error must not surface once WTB is disabled");
  assert.equal(status.wtb.lastSuccessAt, null);
  assert.equal(status.wtb.activeCount, 1, "already-synced WTB rows stay visible/active while disabled");
  assert.equal(status.fs.status, "ok", "FS's own status is unaffected by WTB being disabled");
});

test("getSyncStatus(true) reports WTB's real status once re-enabled", async () => {
  await _resetDbForTests();
  await recordTypeSyncSuccess("WTB");

  const status = await getSyncStatus(true);
  assert.equal(status.wtb.status, "ok");
  assert.ok(status.wtb.lastSuccessAt);
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

test("inventory older than the freshness window is not shown, however active it still is", async () => {
  await _resetDbForTests();
  await upsertListings([row("fresh", "FS")], daysAgo(1));
  await upsertListings([row("edge", "FS")], daysAgo(14));
  await upsertListings([row("stale", "FS")], daysAgo(20));

  const ids = (await getActiveListings("FS")).map((l) => l.id).sort();
  assert.deepEqual(ids, ["edge", "fresh"], "a 20-day-old listing is stale even though is_active is still TRUE");
  assert.equal(config.watchfacts.maxListingAgeDays, 15, "the default window this test is written against");
});

test("age is measured from first sight, so a listing that keeps re-appearing in syncs still ages out", async () => {
  await _resetDbForTests();
  await upsertListings([row("long-runner", "FS")], daysAgo(30));
  // Seen again today: last_seen_at moves forward, first_seen_at deliberately does not.
  await upsertListings([row("long-runner", "FS", { price: "2000" })], daysAgo(0));

  assert.deepEqual(await getActiveListings("FS"), [], "re-sighting must not reset a listing's age");
});
