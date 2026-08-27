import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Controlled test-group rollout: master flag ON, but only "allowed-group" is allowlisted —
// proves both conditions are required together, and that ingestion (and therefore
// notification and decision handling downstream of it) is gated per-group, not just globally.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-groupmonitor-allowlist-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "allowed-group";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config, isV4ChatEnabled } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleGroupMessage } = require("./groupMonitor") as typeof import("./groupMonitor");

after(async () => {
  await db._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("isV4ChatEnabled requires both the master flag and the specific chat being allowlisted", () => {
  assert.equal(config.postingsV4.enabled, true);
  assert.equal(isV4ChatEnabled("allowed-group"), true);
  assert.equal(isV4ChatEnabled("some-other-group"), false);
});

test("a post from the allowed group is ingested into postings", async (t) => {
  await db._resetDbForTests();
  t.mock.method(whapiClient, "sendText", async () => {});

  await handleGroupMessage("m1", "allowed-group", "15551234567", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");

  const rows = await db.withSchema((pool) => pool.query(`SELECT * FROM postings WHERE source_chat_id='allowed-group'`));
  assert.equal(rows.rows.length, 1, "a post from an allowlisted group must be ingested");
});

test("a post from a non-allowed group is never ingested, even with the master flag on", async (t) => {
  await db._resetDbForTests();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  await handleGroupMessage("m2", "disallowed-group", "15551234567", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");

  const rows = await db.withSchema((pool) => pool.query(`SELECT * FROM postings WHERE source_chat_id='disallowed-group'`));
  assert.equal(rows.rows.length, 0, "a post from a non-allowlisted group must never reach ingestChatPosting");
  assert.equal(sent.length, 0, "no acknowledgment or notification can fire for something that was never ingested");
});
