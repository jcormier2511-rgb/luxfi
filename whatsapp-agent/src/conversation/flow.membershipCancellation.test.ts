import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-membership-cancel-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizeNet = require("../billing/authorizeNet") as typeof import("../billing/authorizeNet");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState, getState } = require("./stateStore") as typeof import("./stateStore");

after(async () => {
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});
beforeEach(() => entitlements._resetDbForTests());

let phoneCounter = 0;
function freshPhone(): string {
  phoneCounter += 1;
  const phone = `1555000${String(phoneCounter).padStart(4, "0")}`;
  resetState(phone);
  return phone;
}

for (const trigger of ["fire Fi", "Fire Fi", "cancel my membership", "cancel membership", "cancel my plan", "cancel my subscription"]) {
  test(`"${trigger}" asks for confirmation, and does not cancel anything by itself`, async (t) => {
    const phone = freshPhone();
    t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
      throw new Error("must never be called before an explicit confirm");
    });
    await entitlements.activateMembership(phone, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-1" });

    const reply = await handleIncomingMessage(phone, trigger);
    const text = reply.messages.join("\n");
    assert.match(text, /confirm/i);
    assert.match(text, /Tier 1/);
    assert.equal((await entitlements.getEntitlement(phone)).plan, "tier1", "nothing is cancelled until confirmed");
    assert.equal(getState(phone).pendingMembershipCancellation, true);
  });
}

test('replying "confirm" after "fire Fi" actually cancels the membership', async (t) => {
  const phone = freshPhone();
  const cancelled: string[] = [];
  t.mock.method(authorizeNet, "cancelArbSubscription", async (id: string) => { cancelled.push(id); });
  await entitlements.activateMembership(phone, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-1" });

  await handleIncomingMessage(phone, "fire Fi");
  const reply = await handleIncomingMessage(phone, "confirm");

  assert.match(reply.messages.join("\n"), /cancelled/i);
  assert.deepEqual(cancelled, ["sub-1"]);
  assert.equal((await entitlements.getEntitlement(phone)).plan, null);
  assert.equal(getState(phone).pendingMembershipCancellation, false, "one-shot: cleared after the confirm reply");
});

test('any other reply after "fire Fi" keeps the membership active and does not call Authorize.net', async (t) => {
  const phone = freshPhone();
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called for a non-confirm reply");
  });
  await entitlements.activateMembership(phone, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-1" });

  await handleIncomingMessage(phone, "fire Fi");
  const reply = await handleIncomingMessage(phone, "no wait, nevermind");

  assert.match(reply.messages.join("\n"), /still active/i);
  assert.equal((await entitlements.getEntitlement(phone)).plan, "tier1");
});

test('"cancel my membership" with no active plan says so, with no confirmation step at all', async (t) => {
  const phone = freshPhone();
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called when there is nothing to cancel");
  });

  const reply = await handleIncomingMessage(phone, "cancel my membership");
  assert.match(reply.messages.join("\n"), /not currently a paying/i);
  assert.equal(getState(phone).pendingMembershipCancellation, undefined, "no confirmation is needed when there is nothing to cancel");
});

// The pre-existing bare "cancel" (clears a pending draft/match) must keep working exactly as
// before -- MEMBERSHIP_CANCEL_TRIGGER's regex is specific enough that it must never intercept it.
test('a bare "cancel" is still the draft-cancel command, never membership cancellation', async (t) => {
  const phone = freshPhone();
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called for a bare 'cancel'");
  });
  await entitlements.activateMembership(phone, "tier1", { customerProfileId: "cust-1", paymentProfileId: "pay-1", subscriptionId: "sub-1" });

  const reply = await handleIncomingMessage(phone, "cancel");
  assert.doesNotMatch(reply.messages.join("\n"), /confirm/i);
  assert.equal((await entitlements.getEntitlement(phone)).plan, "tier1", "a bare 'cancel' must never touch billing");
});

// Required behavior change: STOP is the compliance-grade "make it all stop" keyword -- it must
// end billing too, not just messaging, so a paying member who opts out never keeps being charged
// while Fi stays silent.
test("STOP cancels an active membership's billing, not just future messages", async (t) => {
  const phone = freshPhone();
  const cancelled: string[] = [];
  t.mock.method(authorizeNet, "cancelArbSubscription", async (id: string) => { cancelled.push(id); });
  await entitlements.activateMembership(phone, "tier2", { customerProfileId: "cust-2", paymentProfileId: "pay-2", subscriptionId: "sub-2" });

  const reply = await handleIncomingMessage(phone, "STOP");

  assert.match(reply.messages.join("\n"), /unsubscribed/i);
  assert.match(reply.messages.join("\n"), /cancelled/i);
  assert.deepEqual(cancelled, ["sub-2"]);
  assert.equal((await entitlements.getEntitlement(phone)).plan, null);
  assert.equal(getState(phone).stage, "opted_out");
});

test("STOP for a non-member still works exactly as before, with no mention of billing", async (t) => {
  const phone = freshPhone();
  t.mock.method(authorizeNet, "cancelArbSubscription", async () => {
    throw new Error("must never be called for a phone with no plan");
  });

  const reply = await handleIncomingMessage(phone, "STOP");
  const text = reply.messages.join("\n");
  assert.match(text, /You're unsubscribed — you won't hear from Fi again/);
  assert.doesNotMatch(text, /cancelled/i);
});
