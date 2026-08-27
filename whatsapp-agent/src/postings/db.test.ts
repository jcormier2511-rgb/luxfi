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
