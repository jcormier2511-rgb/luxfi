import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// ENABLE_V4_POSTINGS is deliberately left UNSET here — proving the documented default
// (config.postingsV4.enabled === false) actually keeps the v4 ingestion/notification path
// inert, per the "stays disabled in production until verified" requirement.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-groupmonitor-flag-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("../config") as typeof import("../config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleGroupMessage } = require("./groupMonitor") as typeof import("./groupMonitor");

after(() => {
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("the v4 postings path defaults to disabled when ENABLE_V4_POSTINGS is unset", () => {
  assert.equal(config.postingsV4.enabled, false);
});

test("with the v4 flag off, a group WTB post is still captured to the legacy v3 CSV but never reaches postings ingestion or sends anything", async (t) => {
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  await handleGroupMessage("m1", "g1", "15551234567", "Alex", "WTB Rolex Daytona 116500LN budget $30,000");

  assert.ok(fs.existsSync(config.data.groupListingsCsv), "the v3 CSV capture must still work regardless of the v4 flag");
  const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
  assert.match(csv, /WTB/);
  assert.equal(sent.length, 0, "no message of any kind should be sent while the v4 flag is off");
});
