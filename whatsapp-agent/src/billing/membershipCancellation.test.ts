import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizeNet = require("./authorizeNet") as typeof import("./authorizeNet");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cancelOwnMembership } = require("./membershipCancellation") as typeof import("./membershipCancellation");

after(() => entitlements._closePoolForTests());
beforeEach(() => entitlements._resetDbForTests());

const PHONE = "15550008888";

test("a real paying member's ARB subscription is cancelled at Authorize.net, and the entitlement is cleared", async (t) => {
  const cancelled: string[] = [];
  t.mock.method(authorizeNet, "cancelArbSubscription", async (id: string) => { cancelled.push(id); });
  await entitlements.activateMembership(PHONE, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-1" });

  const result = await cancelOwnMembership(PHONE);

  assert.equal(result.hadActivePlan, true);
  assert.equal(result.arbCancelFailed, false);
  assert.deepEqual(cancelled, ["sub-1"], "the real subscription must actually be cancelled at the processor, not just cleared locally");
  const entitlement = await entitlements.getEntitlement(PHONE);
  assert.equal(entitlement.plan, null);
  assert.equal(entitlement.paymentStatus, "canceled");
  assert.ok(entitlement.canceledAt);
});

test("a manual-override member (no real Authorize.net subscription) skips the ARB call entirely", async (t) => {
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called for a phone with no authnetSubscriptionId");
  });
  await entitlements.setPlan(PHONE, "tier1"); // admin-assigned, no authnet ids at all

  const result = await cancelOwnMembership(PHONE);

  assert.equal(result.hadActivePlan, true);
  assert.equal(result.arbCancelFailed, false);
  const entitlement = await entitlements.getEntitlement(PHONE);
  assert.equal(entitlement.plan, null);
});

test("a phone with no plan at all is a no-op, not an error", async (t) => {
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called for a phone with no plan");
  });

  const result = await cancelOwnMembership(PHONE);

  assert.equal(result.hadActivePlan, false);
  assert.equal(result.arbCancelFailed, false);
});

// Real reported risk this guards against: a failed processor call must never leave someone
// stuck in a membership they explicitly asked to leave -- the entitlement is cleared either way,
// and the failure is only ever surfaced as a flag for a human follow-up.
test("the entitlement is cleared even when the Authorize.net cancel call fails", async (t) => {
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => { throw new Error("processor is down"); });
  await entitlements.activateMembership(PHONE, "tier2", { customerProfileId: "cust-2", paymentProfileId: "pay-2", subscriptionId: "sub-2" });

  const result = await cancelOwnMembership(PHONE);

  assert.equal(result.hadActivePlan, true);
  assert.equal(result.arbCancelFailed, true, "the failure must be visible to the caller, not swallowed");
  const entitlement = await entitlements.getEntitlement(PHONE);
  assert.equal(entitlement.plan, null, "the member must not stay locked into a membership they asked to leave, even though the processor call failed");
});
