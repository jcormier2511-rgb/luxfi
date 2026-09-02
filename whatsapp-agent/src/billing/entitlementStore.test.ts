import { test, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore entitlementStore.ts) is first required — see
// the same note in inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
const {
  getEntitlement,
  setManualOverride,
  setPlan,
  recordBillingRequested,
  listAllEntitlements,
  activateMembership,
  cancelMembership,
  findPhoneByAuthnetSubscriptionId,
  createCheckoutSession,
  getCheckoutSession,
  markCheckoutSessionStatus,
  setCheckoutSessionProfileId,
  findCheckoutSessionByProfileId,
  _resetDbForTests,
  _closePoolForTests,
} = entitlements;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { weeklyLimitFor } = require("./plans") as typeof import("./plans");

after(() => _closePoolForTests());

test("a phone with no history defaults to locked (manualOverrideEnabled: false)", async () => {
  await _resetDbForTests();
  const e = await getEntitlement("15551234567");
  assert.equal(e.manualOverrideEnabled, false);
  assert.equal(e.paymentAuthorized, null);
  assert.equal(e.membershipVerified, null);
});

test("setManualOverride(true) unlocks; setManualOverride(false) re-locks", async () => {
  await _resetDbForTests();
  const phone = "15551234567";

  await setManualOverride(phone, true);
  assert.equal((await getEntitlement(phone)).manualOverrideEnabled, true);

  await setManualOverride(phone, false);
  assert.equal((await getEntitlement(phone)).manualOverrideEnabled, false);
});

test("recordBillingRequested never sets manual_override_enabled — only an admin action does", async () => {
  await _resetDbForTests();
  const phone = "15551234567";

  await recordBillingRequested(phone);
  const e = await getEntitlement(phone);
  assert.equal(e.manualOverrideEnabled, false, "join must never self-unlock");
  assert.equal(e.paymentStatus, "requested");
});

test("entitlement is per-phone — overriding one account never affects another", async () => {
  await _resetDbForTests();
  await setManualOverride("15551111111", true);

  assert.equal((await getEntitlement("15551111111")).manualOverrideEnabled, true);
  assert.equal((await getEntitlement("15552222222")).manualOverrideEnabled, false);
});

test("a phone with no history has no plan", async () => {
  await _resetDbForTests();
  const e = await getEntitlement("15553333333");
  assert.equal(e.plan, null);
});

test("setPlan assigns a tier; setPlan(phone, null) clears it back to no plan", async () => {
  await _resetDbForTests();
  const phone = "15554444444";

  await setPlan(phone, "tier1");
  const paid = await getEntitlement(phone);
  assert.equal(paid.plan, "tier1");
  assert.equal(paid.paymentAuthorized, true);
  assert.equal(paid.paymentStatus, "active");

  await setPlan(phone, "tier2");
  assert.equal((await getEntitlement(phone)).plan, "tier2", "reassigning a plan overwrites the previous one");

  await setPlan(phone, null);
  const inactive = await getEntitlement(phone);
  assert.equal(inactive.plan, null);
  assert.equal(inactive.paymentAuthorized, false);
  assert.equal(inactive.paymentStatus, "inactive");
});

test("listAllEntitlements only returns rows that actually exist, and never inserts one as a side effect", async () => {
  await _resetDbForTests();
  await setPlan("15555555555", "tier2");
  // Never touched by getEntitlement/setPlan/etc. -- must simply be absent, not defaulted-and-inserted.
  const untouchedPhone = "15556666666";

  const map = await listAllEntitlements();
  assert.equal(map.size, 1, "only the one real row should exist");
  assert.equal(map.get("15555555555")?.plan, "tier2");
  assert.equal(map.has(untouchedPhone), false, "a phone with no history must not appear, and must not have been inserted");
});

test("weeklyLimitFor: flat-fee tiers cap the week; tier3 and the legacy override are unlimited; no plan is locked", async () => {
  assert.equal(weeklyLimitFor({ plan: null, manualOverrideEnabled: false }), 0, "no active plan and no override = locked");
  assert.equal(weeklyLimitFor({ plan: "tier1", manualOverrideEnabled: false }), 5);
  assert.equal(weeklyLimitFor({ plan: "tier2", manualOverrideEnabled: false }), 20);
  assert.equal(weeklyLimitFor({ plan: "tier3", manualOverrideEnabled: false }), null, "tier3 is unlimited");
  assert.equal(
    weeklyLimitFor({ plan: null, manualOverrideEnabled: true }),
    null,
    "the legacy admin override still means unlimited, even with no plan assigned"
  );
  assert.equal(
    weeklyLimitFor({ plan: "tier1", manualOverrideEnabled: true }),
    null,
    "an override takes precedence over a lower-tier plan"
  );
});

test("activateMembership sets plan + Authorize.net identifiers and clears any prior cancellation", async () => {
  await _resetDbForTests();
  const phone = "15557778888";
  await cancelMembership(phone); // pretend this account canceled once before

  const e = await activateMembership(phone, "tier2", { customerProfileId: "cp1", paymentProfileId: "pp1", subscriptionId: "sub1" });
  assert.equal(e.plan, "tier2");
  assert.equal(e.paymentAuthorized, true);
  assert.equal(e.paymentStatus, "active");
  assert.equal(e.authnetCustomerProfileId, "cp1");
  assert.equal(e.authnetPaymentProfileId, "pp1");
  assert.equal(e.authnetSubscriptionId, "sub1");
  assert.equal(e.canceledAt, null, "re-subscribing clears the earlier cancellation");
});

test("cancelMembership clears the plan, marks canceled_at, and keeps the subscription id as a record", async () => {
  await _resetDbForTests();
  const phone = "15557778889";
  await activateMembership(phone, "tier1", { customerProfileId: "cp2", paymentProfileId: "pp2", subscriptionId: "sub2" });

  const canceled = await cancelMembership(phone);
  assert.equal(canceled.plan, null);
  assert.equal(canceled.paymentAuthorized, false);
  assert.equal(canceled.paymentStatus, "canceled");
  assert.ok(canceled.canceledAt);
  assert.equal(canceled.authnetSubscriptionId, "sub2", "the id stays as a record of what was canceled");
});

test("findPhoneByAuthnetSubscriptionId resolves a live subscription id and returns null for an unknown one", async () => {
  await _resetDbForTests();
  await activateMembership("15557778890", "tier3", { customerProfileId: "cp3", paymentProfileId: "pp3", subscriptionId: "sub3" });

  assert.equal(await findPhoneByAuthnetSubscriptionId("sub3"), "15557778890");
  assert.equal(await findPhoneByAuthnetSubscriptionId("nonexistent"), null);
});

test("checkout sessions: created pending, retrievable by id, and status transitions record the Authorize.net trans id", async () => {
  await _resetDbForTests();
  const session = await createCheckoutSession("15559990000", "tier1");
  assert.equal(session.status, "pending");
  assert.equal(session.plan, "tier1");

  const fetched = await getCheckoutSession(session.id);
  assert.equal(fetched?.phone, "15559990000");

  await markCheckoutSessionStatus(session.id, "completed", "txn123");
  const completed = await getCheckoutSession(session.id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.authnetTransId, "txn123");

  assert.equal(await getCheckoutSession("does-not-exist"), null);
});

test("checkout session profile id: set once GET /pay/:id creates the CIM profile, and traceable back from that id (the only correlation the paymentProfile.created webhook gives us)", async () => {
  await _resetDbForTests();
  const session = await createCheckoutSession("15559990010", "tier2");
  assert.equal(session.authnetCustomerProfileId, null);
  assert.equal(await findCheckoutSessionByProfileId("cp-abc"), null);

  await setCheckoutSessionProfileId(session.id, "cp-abc");
  const updated = await getCheckoutSession(session.id);
  assert.equal(updated?.authnetCustomerProfileId, "cp-abc");

  const found = await findCheckoutSessionByProfileId("cp-abc");
  assert.equal(found?.id, session.id);
  assert.equal(found?.phone, "15559990010");
});

test("admin plan assignment creates briefing-eligible paid state; requested and cleared states remain ineligible", async () => {
  const { isMarketUpdateEligible } = require("../marketUpdates") as typeof import("../marketUpdates");
  await _resetDbForTests();
  const phone = "15556667777";
  await recordBillingRequested(phone);
  assert.equal(isMarketUpdateEligible(await getEntitlement(phone)), false, "requested is unpaid");
  assert.equal(isMarketUpdateEligible(await setPlan(phone, "tier2")), true, "admin-authorized paid membership is eligible");
  assert.equal(isMarketUpdateEligible(await setPlan(phone, null)), false, "cleared membership is inactive");
});
