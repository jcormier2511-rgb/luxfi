import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Telegram groups reuse the exact same handleGroupMessage as WhatsApp groups — platform is
// derived from senderPhone's own "telegram:"/bare-digits prefix (channels/identity.ts), not
// threaded through as a separate parameter. This proves that derivation actually reaches
// Postgres (source_platform) and the legacy CSV (source label), not just the WhatsApp default.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-groupmonitor-telegram-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "tg-group-1";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleGroupMessage } = require("./groupMonitor") as typeof import("./groupMonitor");

after(async () => {
  await db._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
  if (fs.existsSync(config.data.groupListingsCsv)) fs.rmSync(config.data.groupListingsCsv);
});

test("a Telegram group post is ingested with source_platform='telegram', not the WhatsApp default", async (t) => {
  await db._resetDbForTests();
  t.mock.method(whapiClient, "sendText", async () => {});

  await handleGroupMessage("tg-m1", "tg-group-1", "telegram:778899", "Dana", "WTB Rolex Daytona 116500LN budget $30,000");

  const rows = await db.withSchema((pool) => pool.query(`SELECT * FROM postings WHERE source_chat_id='tg-group-1'`));
  assert.equal(rows.rows.length, 1, "a post from an allowlisted Telegram group must be ingested");
  assert.equal(rows.rows[0].source_platform, "telegram");
});

test("a Telegram group post is still captured to the legacy CSV, labeled TG-Group not WA-Group", async (t) => {
  await db._resetDbForTests();
  t.mock.method(whapiClient, "sendText", async () => {});

  await handleGroupMessage("tg-m2", "tg-group-1", "telegram:778899", "Dana", "FS Rolex 116500LN $28,000");

  const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
  assert.match(csv, /TG-Group/);
  assert.doesNotMatch(csv, /WA-Group/);
});
