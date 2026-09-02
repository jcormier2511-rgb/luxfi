import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-server-v4decision-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
// ENABLE_V4_POSTINGS intentionally left unset for this file — proving the gate at the
// server.ts entry point itself, distinct from groupMonitor's own gate.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { config } = require("./config") as typeof import("./config");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tryHandleV4Decision } = require("./server") as typeof import("./server");

after(() => {
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("tryHandleV4Decision is a no-op while the v4 flag is off, even for text that looks like a valid decision command", async () => {
  assert.equal(config.postingsV4.enabled, false);
  const result = await tryHandleV4Decision("15551234567", "approve 1");
  assert.equal(result, null, "must never touch Postgres or reply while the v4 surface is disabled");
});

test("tryHandleV4Decision returns null (never throws) for plain, non-decision text while disabled", async () => {
  const result = await tryHandleV4Decision("15551234567", "hi there");
  assert.equal(result, null);
});
