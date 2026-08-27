import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-server-v4extend-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postings/postingsStore") as typeof import("./postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tryHandleV4Extend } = require("./server") as typeof import("./server");

after(async () => {
  await db._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

test("extend <id> pushes the posting's expiry forward by 30 days for its own owner", async () => {
  await db._resetDbForTests();
  const posting = await store.ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-extend-1",
    senderIdentity: "buyer-extend-1",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  const before = new Date(posting.posting!.expires_at).getTime();

  const reply = await tryHandleV4Extend("buyer-extend-1", `extend ${posting.posting!.id}`);
  assert.match(reply!, /Extended/i);

  const after = await store.getPosting(posting.posting!.id);
  assert.ok(new Date(after!.expires_at).getTime() - before >= 29 * 24 * 60 * 60 * 1000);
});

test("extend <id> is refused (falls through as null) for a posting that isn't the requester's own", async () => {
  await db._resetDbForTests();
  const posting = await store.ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-extend-2",
    senderIdentity: "buyer-extend-2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  const reply = await tryHandleV4Extend("someone-else", `extend ${posting.posting!.id}`);
  assert.equal(reply, null, "must not confirm or deny that the id exists to a non-owner");
});

test("extend <unknown id> is refused the same way as a not-mine id", async () => {
  await db._resetDbForTests();
  const reply = await tryHandleV4Extend("buyer-extend-3", "extend 999999");
  assert.equal(reply, null);
});

test("text that isn't an extend command returns null", async () => {
  const reply = await tryHandleV4Extend("buyer-extend-4", "hello there");
  assert.equal(reply, null);
});
