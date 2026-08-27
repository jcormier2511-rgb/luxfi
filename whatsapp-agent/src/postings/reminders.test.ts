import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.V4_REMINDER_DAYS_BEFORE_EXPIRY = "3";
// sendExpirationReminders is now allowlist-gated at send time — these tests post into chat
// "g1", so v4 needs to be enabled for it here too (see the dedicated
// "never gets a reminder once its group is no longer allowed" test below for the gate itself).
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "g1";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const remindersModule = require("./reminders") as typeof import("./reminders");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");

const { ingestChatPosting, getPosting, extendPosting } = store;
const { sendExpirationReminders } = remindersModule;

after(() => db._closePoolForTests());

async function setExpiresInDays(postingId: number, days: number): Promise<void> {
  await db.withSchema((pool) =>
    pool.query(`UPDATE postings SET expires_at = now() + ($1 || ' days')::interval WHERE id=$2`, [days, postingId])
  );
}

test("a posting inside the reminder window gets exactly one reminder", async (t) => {
  await db._resetDbForTests();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-reminder-1",
    senderIdentity: "buyer-reminder-1",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 2); // inside the 3-day window

  const result = await sendExpirationReminders();
  assert.equal(result.remindersSent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, "buyer-reminder-1");
  assert.match(sent[0].message, new RegExp(`extend ${posting.posting!.id}`));
});

test("a posting outside the reminder window (not yet close to expiring) gets no reminder", async () => {
  await db._resetDbForTests();
  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-reminder-2",
    senderIdentity: "buyer-reminder-2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 20); // well outside the 3-day window

  const result = await sendExpirationReminders();
  assert.equal(result.remindersSent, 0);
});

test("running the reminder sweep twice never sends a duplicate for the same expiration", async (t) => {
  await db._resetDbForTests();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-reminder-3",
    senderIdentity: "buyer-reminder-3",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 1);

  const first = await sendExpirationReminders();
  assert.equal(first.remindersSent, 1);

  const second = await sendExpirationReminders();
  assert.equal(second.remindersSent, 0, "a second sweep before extension/change must never re-send");
  assert.equal(sent.length, 1);
});

test("extending a posting past a sent reminder makes it eligible for a fresh reminder against the new expiry", async (t) => {
  await db._resetDbForTests();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-reminder-4",
    senderIdentity: "buyer-reminder-4",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 1);

  await sendExpirationReminders();
  assert.equal(sent.length, 1, "initial reminder sent");

  // Successful extension (the working "extend" action the spec asks to prove). Compare against
  // the CURRENT expires_at (post-setExpiresInDays), not the posting's original creation-time
  // value, which would make a ~30-day jump look like only ~1 day.
  const before = (await getPosting(posting.posting!.id))!.expires_at;
  const extended = await extendPosting(posting.posting!.id);
  assert.ok(extended, "extendPosting must succeed on an active posting");
  const beforeMs = new Date(before).getTime();
  const afterMs = new Date(extended!.expires_at).getTime();
  assert.ok(afterMs - beforeMs >= 29 * 24 * 60 * 60 * 1000, "extension should push expiry forward by ~30 days");

  // Right after extending, the posting is far from expiring again — no reminder yet.
  const afterExtend = await sendExpirationReminders();
  assert.equal(afterExtend.remindersSent, 0);

  // Move it back into the reminder window (simulating time passing) and confirm a fresh
  // reminder fires for the NEW expiry, proving reminder suppression is per-expiration-version.
  await setExpiresInDays(posting.posting!.id, 1);
  const secondReminder = await sendExpirationReminders();
  assert.equal(secondReminder.remindersSent, 1, "a new expiry must be eligible for its own reminder");
  assert.equal(sent.length, 2);

  const finalPosting = await getPosting(posting.posting!.id);
  assert.equal(
    new Date(finalPosting!.reminder_sent_for_expires_at!).getTime(),
    new Date(finalPosting!.expires_at).getTime()
  );
});

test("an API-mirrored (non-chat) posting never gets an expiration reminder", async () => {
  await db._resetDbForTests();
  await store.mirrorApiFsPosting({
    id: "wf-reminder-1",
    item: "Rolex",
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$28,000",
    contactName: "dealer",
    contactPhone: "dealer-phone",
    description: "",
  });
  const rows = await db.withSchema((pool) => pool.query(`SELECT id FROM postings WHERE source_type='api'`));
  await setExpiresInDays(rows.rows[0].id, 1);

  const result = await sendExpirationReminders();
  assert.equal(result.remindersSent, 0, "reminders are scoped to chat-originated monitors only");
});

test("a posting whose group is no longer on the allowlist never gets a reminder", async (t) => {
  await db._resetDbForTests();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  // This file's V4_ALLOWED_CHAT_IDS is "g1" only — "some-other-group" represents a chat that
  // isn't (or is no longer) on the allowlist, even though the posting already exists.
  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "some-other-group",
    messageId: "wtb-reminder-5",
    senderIdentity: "buyer-reminder-5",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 1);

  const result = await sendExpirationReminders();
  assert.equal(result.remindersSent, 0);
  assert.equal(sent.length, 0);
});

test("a failed send never permanently marks the reminder as sent — it's retried on the next run", async (t) => {
  await db._resetDbForTests();
  let shouldFail = true;
  t.mock.method(whapiClient, "sendText", async () => {
    if (shouldFail) throw new Error("simulated delivery failure");
  });

  const posting = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-reminder-6",
    senderIdentity: "buyer-reminder-6",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await setExpiresInDays(posting.posting!.id, 1);

  const failedRun = await sendExpirationReminders();
  assert.equal(failedRun.remindersSent, 0, "a failed send must not count as sent");

  const afterFailure = await getPosting(posting.posting!.id);
  assert.equal(afterFailure!.reminder_sent_for_expires_at, null, "a failed send must never mark reminder_sent_for_expires_at");

  shouldFail = false;
  const retryRun = await sendExpirationReminders();
  assert.equal(retryRun.remindersSent, 1, "the same posting must be retried and succeed on the next run");
});
