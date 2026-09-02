import { test, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore db.ts) is first required — see the same note
// in watchfacts/inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("./identity") as typeof import("./identity");

after(() => db._closePoolForTests());

test("first contact from a phone auto-creates a canonical user", async () => {
  await db._resetDbForTests();
  const id = await getOrCreateCanonicalUser("whatsapp", "15551234567");
  assert.ok(Number.isInteger(id));
});

test("the same platform+identity always resolves to the same canonical user", async () => {
  await db._resetDbForTests();
  const first = await getOrCreateCanonicalUser("whatsapp", "15551234567");
  const second = await getOrCreateCanonicalUser("whatsapp", "15551234567");
  assert.equal(first, second);
});

test("different phones get different canonical users", async () => {
  await db._resetDbForTests();
  const a = await getOrCreateCanonicalUser("whatsapp", "15551111111");
  const b = await getOrCreateCanonicalUser("whatsapp", "15552222222");
  assert.notEqual(a, b);
});

test("concurrent first-contact calls for the same identity converge on one canonical user", async () => {
  await db._resetDbForTests();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => getOrCreateCanonicalUser("whatsapp", "15559999999"))
  );
  assert.equal(new Set(results).size, 1, "a race between concurrent inserts must not create duplicate users");
});
