import { test, after } from "node:test";
import assert from "node:assert/strict";

// Must be set before config.ts (and therefore entitlementStore.ts) is first required — see
// the same note in inventoryDb.test.ts.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
const { getEntitlement, setManualOverride, recordBillingRequested, _resetDbForTests, _closePoolForTests } = entitlements;

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
