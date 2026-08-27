import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_V4_POSTINGS = "true";
// Only "allowed-group" is allowlisted — "disallowed-group" represents a group that was
// removed from V4_ALLOWED_CHAT_IDS (or was never added) after postings from it may already
// exist in the table, proving the allowlist is enforced at notification/decision time, not
// only once at ingestion.
process.env.V4_ALLOWED_CHAT_IDS = "allowed-group";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const matching = require("./matching") as typeof import("./matching");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("./notify") as typeof import("./notify");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch, passMatch } = notify;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
});

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await entitlements._resetDbForTests();
}

let counter = 0;
/**
 * Ingests directly via ingestChatPosting (bypassing groupMonitor's own ingestion-time gate)
 * to simulate a posting that already exists from BEFORE its group was removed from the
 * allowlist — exactly the scenario this feature must handle, since the gate can't "un-ingest"
 * something already stored.
 */
async function createMatchInChat(chatId: string, buyerPhone: string): Promise<{ matchId: number }> {
  const n = ++counter;
  const ref = `GATE${n}`;
  await mirrorApiFsPosting({
    id: `wf-gate-${n}`,
    item: "Rolex",
    brand: "Rolex",
    ref,
    condition: "New",
    price: "$10,000",
    contactName: `dealer-${n}`,
    contactPhone: `dealer-${n}`,
    description: "",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId,
    messageId: `wtb-gate-${n}`,
    senderIdentity: buyerPhone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return { matchId: matches.rows[0].id };
}

test("notification time: a recipient whose own posting is from a disallowed chat gets no notification, though the match itself is still created", async (t) => {
  await resetAll();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  const { matchId } = await createMatchInChat("disallowed-group", "buyer-gate-1");

  assert.equal(sent.length, 0, "no notification should reach a recipient from a disallowed group");
  const match = await db.withSchema((pool) => pool.query(`SELECT * FROM matches WHERE id=$1`, [matchId]));
  assert.equal(match.rows.length, 1, "the match itself is still recorded — only the outbound message is suppressed");
});

test("notification time: a recipient whose own posting is from an allowed chat still gets notified normally", async (t) => {
  await resetAll();
  const sent: { phone: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string) => {
    sent.push({ phone });
  });

  await createMatchInChat("allowed-group", "buyer-gate-2");

  assert.ok(sent.some((s) => s.phone === "buyer-gate-2"), "a recipient from an allowed group must still be notified");
});

test("decision time: approveMatch refuses a match whose own posting is from a disallowed chat", async () => {
  await resetAll();
  const { matchId } = await createMatchInChat("disallowed-group", "buyer-gate-3");

  const outcome = await approveMatch(matchId, "buyer-gate-3");
  assert.equal(outcome.status, "invalid");
});

test("decision time: passMatch refuses a match whose own posting is from a disallowed chat", async () => {
  await resetAll();
  const { matchId } = await createMatchInChat("disallowed-group", "buyer-gate-4");

  const result = await passMatch(matchId, "buyer-gate-4");
  assert.equal(result, "invalid");
});

test("decision time: approveMatch still works normally for a match from an allowed chat", async () => {
  await resetAll();
  const { matchId } = await createMatchInChat("allowed-group", "buyer-gate-5");

  const outcome = await approveMatch(matchId, "buyer-gate-5");
  assert.equal(outcome.status, "approved");
});
