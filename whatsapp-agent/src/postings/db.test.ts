import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// ENABLE_V4_POSTINGS intentionally left unset — proving schema init is unconditional and safe
// even while v4 stays fully disabled.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");

after(() => db._closePoolForTests());

test("initSchema succeeds twice in a row and stays idempotent, while v4 behavior stays disabled", async () => {
  await db._resetDbForTests(); // start from a clean slate for this test's own assertions

  assert.equal(config.postingsV4.enabled, false);

  await assert.doesNotReject(db.initSchema());
  await assert.doesNotReject(db.initSchema());

  const tables = await db.withSchema((pool) =>
    pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN
         ('canonical_users','linked_identities','postings','posting_images','matches','match_recipients','approvals','billing_ledger','reconciliation_runs')`
    )
  );
  assert.equal(tables.rows.length, 9, "every v4 table must exist after schema init, even with v4 disabled");

  // Initializing the schema must never process any postings or send anything — it only
  // creates tables/indexes. With v4 disabled, nothing should exist in them.
  const postings = await db.withSchema((pool) => pool.query(`SELECT * FROM postings`));
  assert.equal(postings.rows.length, 0, "schema init must never create/process any posting data");
});

test("legacy 30-day active records are capped idempotently without extending shorter or reopening closed records", async () => {
  await db._resetDbForTests();
  await db.withSchema((pool) =>
    pool.query(`
      INSERT INTO postings
        (source_platform, source_type, type, status, expires_at, created_at, renewed_at, original_text)
      VALUES
        ('test','direct','WTB','active', now() + interval '25 days', now() - interval '5 days', NULL, 'legacy 30-day'),
        ('test','direct','FS','active', now() + interval '28 days', now() - interval '20 days', now() - interval '2 days', 'renewed legacy'),
        ('test','direct','WTB','active', now() + interval '2 days', now() - interval '1 day', NULL, 'already shorter'),
        ('test','direct','FS','sold', now() + interval '25 days', now() - interval '5 days', NULL, 'closed legacy')
    `)
  );

  assert.equal(await db.capActivePostingExpirations(), 2);
  const first = await db.withSchema((pool) =>
    pool.query(`SELECT original_text, status, expires_at, created_at, renewed_at FROM postings ORDER BY id`)
  );
  const expiry = (row: any) => new Date(row.expires_at).getTime();
  const anchor = (row: any) => new Date(row.renewed_at ?? row.created_at).getTime();
  assert.ok(Math.abs(expiry(first.rows[0]) - anchor(first.rows[0]) - 15 * 86400_000) < 1_000, "legacy active record is capped from creation");
  assert.ok(Math.abs(expiry(first.rows[1]) - anchor(first.rows[1]) - 15 * 86400_000) < 1_000, "renewed record is capped from explicit renewal");
  const shorterExpiry = expiry(first.rows[2]);
  const closedExpiry = expiry(first.rows[3]);
  assert.equal(first.rows[3].status, "sold");

  assert.equal(await db.capActivePostingExpirations(), 0, "a second migration pass is a no-op");
  const second = await db.withSchema((pool) => pool.query(`SELECT expires_at, status FROM postings ORDER BY id`));
  assert.equal(expiry(second.rows[2]), shorterExpiry, "an already-shorter expiry is never extended");
  assert.equal(expiry(second.rows[3]), closedExpiry, "a closed record remains completely untouched");
  assert.equal(second.rows[3].status, "sold");
});
