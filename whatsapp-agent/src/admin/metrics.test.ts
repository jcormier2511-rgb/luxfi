import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getAdminMetrics } = require("./metrics") as typeof import("./metrics");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logSearchRequest } = require("../postings/analytics") as typeof import("../postings/analytics");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notificationPreferences = require("../postings/notificationPreferences") as typeof import("../postings/notificationPreferences");

after(async () => {
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
});

async function setApprovedCount(canonicalUserId: number, count: number): Promise<void> {
  await postingsDb.withSchema((pool) => pool.query(`UPDATE canonical_users SET total_approved_count=$1 WHERE id=$2`, [count, canonicalUserId]));
}

test("getAdminMetrics buckets users into paid/trial/nonPaying/canceledApprox correctly", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();

  // Paid: has a plan.
  await getOrCreateCanonicalUser("whatsapp", "15551110000");
  await entitlements.setPlan("15551110000", "tier1");

  // Trial: no plan, under the trial cap (default 3).
  const trialUserId = await getOrCreateCanonicalUser("whatsapp", "15552220000");
  await setApprovedCount(trialUserId, 1);

  // Non-paying: no plan, trial exhausted.
  const exhaustedUserId = await getOrCreateCanonicalUser("whatsapp", "15553330000");
  await setApprovedCount(exhaustedUserId, 3);

  // Brand new: no plan, zero approvals -- trial bucket, and NOT counted as approximated-canceled.
  await getOrCreateCanonicalUser("whatsapp", "15554440000");

  const metrics = await getAdminMetrics();
  assert.equal(metrics.membership.totalUsers, 4);
  assert.equal(metrics.membership.paid, 1);
  assert.equal(metrics.membership.trial, 2, "the 1-approval user and the brand-new user are both still in trial");
  assert.equal(metrics.membership.nonPaying, 1);
  assert.equal(
    metrics.membership.canceledApprox,
    2,
    "the 1-approval and 3-approval users both count as approximated-canceled (approved at least once, no plan); the brand-new user does not"
  );
});

test("a manual override counts as paid even with no plan assigned", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  await getOrCreateCanonicalUser("whatsapp", "15551110000");
  await entitlements.setManualOverride("15551110000", true);

  const metrics = await getAdminMetrics();
  assert.equal(metrics.membership.paid, 1);
  assert.equal(metrics.membership.trial, 0);
});

test("a currently-paying user is never counted toward canceledApprox, even with prior approvals", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const paidUserId = await getOrCreateCanonicalUser("whatsapp", "15551110000");
  await setApprovedCount(paidUserId, 5);
  await entitlements.setPlan("15551110000", "tier2");

  const metrics = await getAdminMetrics();
  assert.equal(metrics.membership.paid, 1);
  assert.equal(metrics.membership.canceledApprox, 0);
});

test("getAdminMetrics surfaces top requests and per-user activity", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  await getOrCreateCanonicalUser("whatsapp", "15551110000");
  await logSearchRequest("15551110000", "buy", "Rolex Daytona");
  await logSearchRequest("15551110000", "buy", "Rolex Daytona");

  const metrics = await getAdminMetrics();
  assert.equal(metrics.topRequests[0].query, "Rolex Daytona");
  assert.equal(metrics.topRequests[0].count, 2);
  assert.equal(metrics.activityByUser.length, 1);
  assert.equal(metrics.activityByUser[0].phone, "15551110000");
  assert.equal(metrics.activityByUser[0].searches, 2);
  assert.equal(metrics.activityByUser[0].approvals, 0);
  assert.equal(metrics.activityByUser[0].preferredChannel, null, "no preference stated yet");
  assert.deepEqual(metrics.activityByUser[0].linkedIdentities, [{ platform: "whatsapp", identity: "15551110000" }]);
});

test("a canonical user with a second linked identity is counted once, not twice, and both identities are surfaced", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const userId = await getOrCreateCanonicalUser("whatsapp", "15551110000");
  await notificationPreferences.linkIdentity(userId, "telegram", "telegram:9001");
  await notificationPreferences.setPreferredChannel(userId, "telegram");
  await logSearchRequest("15551110000", "buy", "Rolex Daytona");

  const metrics = await getAdminMetrics();
  assert.equal(metrics.membership.totalUsers, 1, "one canonical user with two linked identities is still one user");

  assert.equal(metrics.activityByUser.length, 1, "the search only attaches to the identity that made it, not a duplicate row per linked identity");
  const row = metrics.activityByUser[0];
  assert.equal(row.preferredChannel, "telegram");
  assert.deepEqual(
    row.linkedIdentities.slice().sort((a, b) => a.platform.localeCompare(b.platform)),
    [
      { platform: "telegram", identity: "telegram:9001" },
      { platform: "whatsapp", identity: "15551110000" },
    ]
  );
});

test("payments summary is always $0 -- no live payment processor exists yet", async () => {
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const metrics = await getAdminMetrics();
  assert.equal(metrics.payments.yearToDateCents, 0);
  assert.equal(metrics.payments.currentMonthCents, 0);
  assert.equal(metrics.payments.currency, "USD");
});
