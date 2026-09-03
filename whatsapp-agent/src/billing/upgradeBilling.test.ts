import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizeNet = require("./authorizeNet") as typeof import("./authorizeNet");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activateClaimedCheckout } = require("./checkoutReconciliation") as typeof import("./checkoutReconciliation");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const approvalUsage = require("../postings/approvalUsage") as typeof import("../postings/approvalUsage");

after(() => entitlements._closePoolForTests());
beforeEach(() => entitlements._resetDbForTests());

const PHONE = "15550009999";
const session = (id: string, plan: "tier1" | "tier2") =>
  ({ id, phone: PHONE, plan, status: "pending" }) as unknown as import("./entitlementStore").CheckoutSession;

/** Stub the processor and the ledger; the subject here is which subscriptions end up cancelled. */
function stubProcessor(t: any, newSubscriptionId: string, onCancel: (id: string) => void | Promise<void>) {
  t.mock.method(authorizeNet, "createProfileTransaction", async () => ({ responseCode: "1", transId: "tx-1", settleAmountCents: 5000 }));
  t.mock.method(authorizeNet, "createArbSubscription", async () => newSubscriptionId);
  t.mock.method(authorizeNet, "cancelArbSubscription", async (id: string) => { await onCancel(id); });
  t.mock.method(approvalUsage, "recordMembershipPayment", async () => {});
  t.mock.method(entitlements, "markCheckoutSessionStatus", async () => {});
}

/**
 * Upgrading creates a NEW ARB subscription. Nothing cancelled the old one, so a member moving
 * tier1 -> tier2 was charged $50 AND $150 every month — and activateMembership overwrote the
 * id needed to stop it in the same statement, so it could not even be found afterwards.
 */
test("upgrading cancels the subscription it replaces", async (t) => {
  const cancelled: string[] = [];
  stubProcessor(t, "sub-tier2", (id) => { cancelled.push(id); });
  await entitlements.activateMembership(PHONE, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-tier1" });

  await activateClaimedCheckout(session("chk-2", "tier2"), "cust-1", "pay-1", "webhook");

  assert.deepEqual(cancelled, ["sub-tier1"], "the old subscription must be cancelled, not left billing");
  const after = await entitlements.getEntitlement(PHONE);
  assert.equal(after.plan, "tier2");
  assert.equal(after.authnetSubscriptionId, "sub-tier2");
  assert.equal(after.supersededSubscriptionId, null, "and the to-do flag clears once it is confirmed cancelled");
});

test("a first-time activation cancels nothing", async (t) => {
  const cancelled: string[] = [];
  stubProcessor(t, "sub-tier1", (id) => { cancelled.push(id); });

  await activateClaimedCheckout(session("chk-1", "tier1"), "cust-1", "pay-1", "webhook");

  assert.deepEqual(cancelled, [], "there is no previous subscription to cancel");
  assert.equal((await entitlements.getEntitlement(PHONE)).supersededSubscriptionId, null);
});

/**
 * The failure mode that must never cost the customer their access: they have just paid.
 * Leaving the old subscription billing is bad, but it is exactly today's behaviour — the
 * difference is that it is now recorded and recoverable rather than lost.
 */
test("a failed cancellation never costs the customer the membership they just paid for", async (t) => {
  stubProcessor(t, "sub-tier2", () => { throw new Error("Authorize.net unavailable"); });
  await entitlements.activateMembership(PHONE, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-tier1" });

  const outcome = await activateClaimedCheckout(session("chk-2", "tier2"), "cust-1", "pay-1", "webhook");

  assert.equal(outcome, "activated", "activation must not be undone by a cancellation failure");
  const after = await entitlements.getEntitlement(PHONE);
  assert.equal(after.plan, "tier2");
  assert.equal(after.supersededSubscriptionId, "sub-tier1", "the id survives so it can be cancelled by hand");
  assert.deepEqual(await entitlements.findUncancelledSupersededSubscriptions(), [{ phone: PHONE, subscriptionId: "sub-tier1" }],
    "and it shows up on the operator's to-do list rather than being silently lost");
});

test("re-activating the SAME subscription id supersedes nothing", async (t) => {
  const cancelled: string[] = [];
  stubProcessor(t, "sub-tier1", (id) => { cancelled.push(id); });
  await entitlements.activateMembership(PHONE, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-tier1" });

  await activateClaimedCheckout(session("chk-dup", "tier1"), "cust-1", "pay-1", "reconciliation");

  assert.deepEqual(cancelled, [], "a webhook and a sweep landing on the same subscription must not cancel it");
});
