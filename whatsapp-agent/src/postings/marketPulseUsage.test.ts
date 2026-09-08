import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Market Pulse look-ups are metered completely separately from approved-match introductions
// (postings/approvalUsage.ts) -- a price/trend lookup is read-only, never an introduction, so
// it must never draw down or share that trial/weekly counter. Same trial-then-membership shape
// (N free, then a weekly cap), but the weekly cap is a FLAT number for any active membership
// tier, unlike approvals which scale with plan.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-marketpulseusage-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_MARKET_PULSE_LOOKUPS = "3";
process.env.MARKET_PULSE_WEEKLY_LIMIT = "10";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const marketPulseUsage = require("./marketPulseUsage") as typeof import("./marketPulseUsage");

const { getMarketPulseUsage, evaluateMarketPulseGate, recordMarketPulseLookup, formatMarketPulseUsageNote } = marketPulseUsage;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await entitlements._resetDbForTests();
}

async function burnTrial(phone: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const usage = await getMarketPulseUsage(phone);
    const gate = evaluateMarketPulseGate(usage);
    assert.equal(gate.allowed, true, `trial lookup #${i + 1} should be allowed`);
    if (gate.allowed) await recordMarketPulseLookup(usage.canonicalUserId, gate.isComplimentary);
  }
}

test("evaluateMarketPulseGate: pure decision logic for each usage shape", () => {
  assert.deepEqual(
    evaluateMarketPulseGate({ canonicalUserId: 1, totalLookups: 0, isComplimentary: true, weeklyLimit: 0, weeklyUsed: 0 }),
    { allowed: true, isComplimentary: true },
    "still within the free trial, regardless of plan"
  );
  assert.deepEqual(
    evaluateMarketPulseGate({ canonicalUserId: 1, totalLookups: 3, isComplimentary: false, weeklyLimit: 0, weeklyUsed: 0 }),
    { allowed: false, reason: "no_plan" },
    "trial exhausted, no plan assigned"
  );
  assert.deepEqual(
    evaluateMarketPulseGate({ canonicalUserId: 1, totalLookups: 3, isComplimentary: false, weeklyLimit: 10, weeklyUsed: 9 }),
    { allowed: true, isComplimentary: false },
    "under the flat weekly cap"
  );
  assert.deepEqual(
    evaluateMarketPulseGate({ canonicalUserId: 1, totalLookups: 3, isComplimentary: false, weeklyLimit: 10, weeklyUsed: 10 }),
    { allowed: false, reason: "weekly_cap", weeklyLimit: 10 },
    "exactly at the weekly cap is blocked, not one past it"
  );
  assert.deepEqual(
    evaluateMarketPulseGate({ canonicalUserId: 1, totalLookups: 999, isComplimentary: false, weeklyLimit: null, weeklyUsed: 0 }),
    { allowed: true, isComplimentary: false },
    "admin override (unlimited) never checks weekly usage at all"
  );
});

test("required: 3 free look-ups during trial, then no plan locks with reason no_plan", async () => {
  await resetAll();
  const phone = "mp-buyer-noplan";
  await burnTrial(phone);

  const usage = await getMarketPulseUsage(phone);
  assert.equal(usage.isComplimentary, false, "trial is exhausted after 3");
  const gate = evaluateMarketPulseGate(usage);
  assert.deepEqual(gate, { allowed: false, reason: "no_plan" });
});

test("required: any active membership plan grants a flat 10/week regardless of tier", async () => {
  await resetAll();
  const phone = "mp-buyer-tier1";
  await burnTrial(phone);
  await entitlements.setPlan(phone, "tier1");

  for (let i = 0; i < 10; i++) {
    const usage = await getMarketPulseUsage(phone);
    const gate = evaluateMarketPulseGate(usage);
    assert.equal(gate.allowed, true, `member look-up #${i + 1} of 10 should be allowed`);
    if (gate.allowed) await recordMarketPulseLookup(usage.canonicalUserId, gate.isComplimentary);
  }

  const usage = await getMarketPulseUsage(phone);
  const gate = evaluateMarketPulseGate(usage);
  assert.deepEqual(gate, { allowed: false, reason: "weekly_cap", weeklyLimit: 10 });
});

test("required: a tier2/tier3 member gets the SAME flat 10/week as tier1 -- the cap does not scale with plan the way approvals do", async () => {
  await resetAll();
  const phone = "mp-buyer-tier3";
  await burnTrial(phone);
  await entitlements.setPlan(phone, "tier3");

  for (let i = 0; i < 10; i++) {
    const usage = await getMarketPulseUsage(phone);
    const gate = evaluateMarketPulseGate(usage);
    assert.equal(gate.allowed, true);
    if (gate.allowed) await recordMarketPulseLookup(usage.canonicalUserId, gate.isComplimentary);
  }
  const usage = await getMarketPulseUsage(phone);
  assert.deepEqual(evaluateMarketPulseGate(usage), { allowed: false, reason: "weekly_cap", weeklyLimit: 10 });
});

test("required: an admin manual override is truly unlimited -- no weekly counting applied at all", async () => {
  await resetAll();
  const phone = "mp-buyer-unlimited";
  await burnTrial(phone);
  await entitlements.setManualOverride(phone, true);

  for (let i = 0; i < 25; i++) {
    const usage = await getMarketPulseUsage(phone);
    const gate = evaluateMarketPulseGate(usage);
    assert.equal(gate.allowed, true, `override look-up #${i + 1} of 25 should never be blocked`);
    if (gate.allowed) await recordMarketPulseLookup(usage.canonicalUserId, gate.isComplimentary);
  }
});

test("required: the weekly cap is a rolling 7-day window, not a lifetime count", async () => {
  await resetAll();
  const phone = "mp-buyer-rolling";
  await burnTrial(phone);
  await entitlements.setPlan(phone, "tier1");

  for (let i = 0; i < 10; i++) {
    const usage = await getMarketPulseUsage(phone);
    const gate = evaluateMarketPulseGate(usage);
    if (gate.allowed) await recordMarketPulseLookup(usage.canonicalUserId, gate.isComplimentary);
  }
  const usageBefore = await getMarketPulseUsage(phone);
  assert.equal(usageBefore.weeklyUsed, 10);

  await db.withSchema((pool) =>
    pool.query(
      `UPDATE market_pulse_lookups SET created_at = now() - interval '8 days'
       WHERE id IN (
         SELECT id FROM market_pulse_lookups
         WHERE canonical_user_id = $1 AND is_complimentary = false
         ORDER BY id LIMIT 4
       )`,
      [usageBefore.canonicalUserId]
    )
  );

  const usageAfter = await getMarketPulseUsage(phone);
  assert.equal(usageAfter.weeklyUsed, 6, "only the 6 still-within-7-days look-ups should count");
});

test("formatMarketPulseUsageNote: advises usage on every allowed reply, not only once the cap is hit", () => {
  const complimentary = formatMarketPulseUsageNote(
    { canonicalUserId: 1, totalLookups: 0, isComplimentary: true, weeklyLimit: 0, weeklyUsed: 0 },
    { allowed: true, isComplimentary: true }
  );
  assert.match(complimentary, /2 of 3 free look-ups left/);

  const lastFreeOne = formatMarketPulseUsageNote(
    { canonicalUserId: 1, totalLookups: 2, isComplimentary: true, weeklyLimit: 0, weeklyUsed: 0 },
    { allowed: true, isComplimentary: true }
  );
  assert.match(lastFreeOne, /used your 3 free Market Pulse look-ups/i, "the exhausting call surfaces the upgrade offer immediately, not a plain '0 of 3 left' note");
  assert.match(lastFreeOne, /"join"/, "must name the actual word to say, same as the blocked-attempt message");

  const memberNote = formatMarketPulseUsageNote(
    { canonicalUserId: 1, totalLookups: 3, isComplimentary: false, weeklyLimit: 10, weeklyUsed: 4 },
    { allowed: true, isComplimentary: false }
  );
  assert.match(memberNote, /5 of 10 used this week/);

  const unlimitedNote = formatMarketPulseUsageNote(
    { canonicalUserId: 1, totalLookups: 999, isComplimentary: false, weeklyLimit: null, weeklyUsed: 0 },
    { allowed: true, isComplimentary: false }
  );
  assert.equal(unlimitedNote, "", "an unlimited/admin-override account gets no nagging usage note");
});
