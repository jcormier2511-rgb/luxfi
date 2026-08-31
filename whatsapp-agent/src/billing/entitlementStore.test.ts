import { test, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore entitlementStore.ts) is first required — see
// the same note in inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
const { getEntitlement, setManualOverride, setPlan, recordBillingRequested, _resetDbForTests, _closePoolForTests } = entitlements;
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

test("admin plan assignment creates briefing-eligible paid state; requested and cleared states remain ineligible", async () => {
  const { isMarketUpdateEligible } = require("../marketUpdates") as typeof import("../marketUpdates");
  await _resetDbForTests();
  const phone = "15556667777";
  await recordBillingRequested(phone);
  assert.equal(isMarketUpdateEligible(await getEntitlement(phone)), false, "requested is unpaid");
  assert.equal(isMarketUpdateEligible(await setPlan(phone, "tier2")), true, "admin-authorized paid membership is eligible");
  assert.equal(isMarketUpdateEligible(await setPlan(phone, null)), false, "cleared membership is inactive");
});
