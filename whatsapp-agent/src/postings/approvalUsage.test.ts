import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR: approveMatch now also touches conversation state (markPendingEscrowOffer,
// see conversation/stateStore.ts) — without this, that would write real conversations.json rows
// into the repo's own ./persist.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-approvalusage-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

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
const approvalUsage = require("./approvalUsage") as typeof import("./approvalUsage");

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch } = notify;
const { getApprovalUsage, evaluateApprovalGate } = approvalUsage;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

let counter = 0;
/** Same pattern as notify.test.ts's createMatch: a WTB (chat) matched against an API-mirrored
 *  FS listing with no WhatsApp identity to wait on, so a single approval reveals immediately —
 *  isolates these tests from the separate mutual-confirmation behavior. */
async function createMatch(buyerPhone: string): Promise<{ matchId: number }> {
  const n = ++counter;
  const ref = `WKREF${n}`;
  await mirrorApiFsPosting({
    id: `wf-wk-${n}`,
    item: "Rolex",
    brand: "Rolex",
    ref,
    condition: "New",
    price: "$10,000",
    contactName: `seller-wk-${n}`,
    contactPhone: `seller-wk-${n}`,
    description: "",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `wtb-wk-${n}`,
    senderIdentity: buyerPhone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return { matchId: matches.rows[0].id };
}

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await entitlements._resetDbForTests();
  counter = 0;
}

async function burnTrial(buyerPhone: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const { matchId } = await createMatch(buyerPhone);
    const outcome = await approveMatch(matchId, buyerPhone);
    assert.equal(outcome.status, "approved", `trial approval #${i + 1} should succeed`);
  }
}

test("evaluateApprovalGate: pure decision logic for each usage shape", () => {
  const base = {
    canonicalUserId: 1,
    entitlement: {
      phone: "x",
      manualOverrideEnabled: false,
      membershipVerified: null,
      paymentAuthorized: null,
      paymentStatus: null,
      plan: null,
      authnetCustomerProfileId: null,
      authnetPaymentProfileId: null,
      authnetSubscriptionId: null,
      supersededSubscriptionId: null,
      canceledAt: null,
    },
  };

  assert.deepEqual(
    evaluateApprovalGate({ ...base, totalApproved: 0, isComplimentary: true, weeklyLimit: 0, weeklyUsed: 0 }),
    { allowed: true, isComplimentary: true },
    "still within the lifetime trial, regardless of plan"
  );
  assert.deepEqual(
    evaluateApprovalGate({ ...base, totalApproved: 3, isComplimentary: false, weeklyLimit: 0, weeklyUsed: 0 }),
    { allowed: false, reason: "no_plan" },
    "trial exhausted, no plan assigned"
  );
  assert.deepEqual(
    evaluateApprovalGate({
      ...base,
      entitlement: { ...base.entitlement, plan: "tier1" },
      totalApproved: 3,
      isComplimentary: false,
      weeklyLimit: 5,
      weeklyUsed: 4,
    }),
    { allowed: true, isComplimentary: false },
    "under the weekly cap"
  );
  assert.deepEqual(
    evaluateApprovalGate({
      ...base,
      entitlement: { ...base.entitlement, plan: "tier1" },
      totalApproved: 3,
      isComplimentary: false,
      weeklyLimit: 5,
      weeklyUsed: 5,
    }),
    { allowed: false, reason: "weekly_cap", plan: "tier1", weeklyLimit: 5 },
    "exactly at the weekly cap is blocked, not one past it"
  );
  assert.deepEqual(
    evaluateApprovalGate({ ...base, totalApproved: 999, isComplimentary: false, weeklyLimit: null, weeklyUsed: 0 }),
    { allowed: true, isComplimentary: false },
    "unlimited tier (or legacy override) never checks weekly usage at all"
  );
});

test("required: no plan assigned locks approvals immediately after the trial, with reason no_plan", async () => {
  await resetAll();
  const buyer = "buyer-noplan";
  await burnTrial(buyer);

  const { matchId } = await createMatch(buyer);
  const outcome = await approveMatch(matchId, buyer);
  assert.equal(outcome.status, "locked");
  assert.equal(outcome.lockReason, "no_plan");
});

test("required: a tier1 plan (5/week) allows exactly 5 non-complimentary approvals, then locks with reason weekly_cap", async () => {
  await resetAll();
  const buyer = "buyer-tier1";
  await burnTrial(buyer);
  await entitlements.setPlan(buyer, "tier1");

  for (let i = 0; i < 5; i++) {
    const { matchId } = await createMatch(buyer);
    const outcome = await approveMatch(matchId, buyer);
    assert.equal(outcome.status, "approved", `plan approval #${i + 1} should succeed within the weekly cap`);
  }

  const { matchId: sixthMatchId } = await createMatch(buyer);
  const sixth = await approveMatch(sixthMatchId, buyer);
  assert.equal(sixth.status, "locked");
  assert.equal(sixth.lockReason, "weekly_cap");
  assert.equal(sixth.plan, "tier1");
  assert.equal(sixth.weeklyLimit, 5);
});

test("required: upgrading tier1 -> tier2 mid-week immediately raises the cap for a previously-blocked account", async () => {
  await resetAll();
  const buyer = "buyer-upgrade";
  await burnTrial(buyer);
  await entitlements.setPlan(buyer, "tier1");

  for (let i = 0; i < 5; i++) {
    const { matchId } = await createMatch(buyer);
    await approveMatch(matchId, buyer);
  }
  const { matchId: blockedMatchId } = await createMatch(buyer);
  assert.equal((await approveMatch(blockedMatchId, buyer)).status, "locked");

  await entitlements.setPlan(buyer, "tier2");
  const sixth = await approveMatch(blockedMatchId, buyer);
  assert.equal(sixth.status, "approved", "the same previously-blocked match now succeeds under the higher tier2 cap");

  for (let i = 0; i < 13; i++) {
    // 6 already used (5 + the unblocked 6th); tier2 allows 20/week — 14 more room, use 13 to stay under.
    const { matchId } = await createMatch(buyer);
    const outcome = await approveMatch(matchId, buyer);
    assert.equal(outcome.status, "approved", `tier2 approval should still be under its 20/week cap (attempt ${i + 1})`);
  }
});

test("required: tier3 is truly unlimited — no weekly counting applied at all", async () => {
  await resetAll();
  const buyer = "buyer-unlimited";
  await burnTrial(buyer);
  await entitlements.setPlan(buyer, "tier3");

  for (let i = 0; i < 25; i++) {
    const { matchId } = await createMatch(buyer);
    const outcome = await approveMatch(matchId, buyer);
    assert.equal(outcome.status, "approved", `tier3 approval #${i + 1} of 25 should never be blocked`);
  }
});

test("required: the weekly cap is a rolling 7-day window, not a lifetime count — an approval older than 7 days doesn't count against this week", async () => {
  await resetAll();
  const buyer = "buyer-rolling";
  await burnTrial(buyer);
  await entitlements.setPlan(buyer, "tier1");

  // Use all 5 of this week's slots normally.
  for (let i = 0; i < 5; i++) {
    const { matchId } = await createMatch(buyer);
    await approveMatch(matchId, buyer);
  }
  const usageBefore = await getApprovalUsage(buyer);
  assert.equal(usageBefore.weeklyUsed, 5);

  // Backdate two of those five approval rows to 8 days ago — outside the rolling window.
  await db.withSchema((pool) =>
    pool.query(
      `UPDATE approvals SET created_at = now() - interval '8 days'
       WHERE id IN (
         SELECT id FROM approvals
         WHERE approving_canonical_user_id = $1 AND is_complimentary = false
         ORDER BY id LIMIT 2
       )`,
      [usageBefore.canonicalUserId]
    )
  );

  const usageAfter = await getApprovalUsage(buyer);
  assert.equal(usageAfter.weeklyUsed, 3, "only the 3 still-within-7-days approvals should count");

  // With only 3 of 5 counted now, 2 more approvals should be allowed before locking again.
  const { matchId: sixthMatchId } = await createMatch(buyer);
  assert.equal((await approveMatch(sixthMatchId, buyer)).status, "approved");
  const { matchId: seventhMatchId } = await createMatch(buyer);
  assert.equal((await approveMatch(seventhMatchId, buyer)).status, "approved");
  const { matchId: eighthMatchId } = await createMatch(buyer);
  assert.equal((await approveMatch(eighthMatchId, buyer)).status, "locked", "back at 5 counted within the window, locked again");
});
