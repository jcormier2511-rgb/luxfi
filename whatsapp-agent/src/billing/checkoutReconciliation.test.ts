import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-checkout-recon-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token";
process.env.WHAPI_TOKEN = "";
process.env.AUTHORIZENET_API_LOGIN_ID = "test-login-id";
process.env.AUTHORIZENET_TRANSACTION_KEY = "test-transaction-key";
process.env.AUTHORIZENET_SIGNATURE_KEY = "test-signature-key";

const entitlements = require("./entitlementStore") as typeof import("./entitlementStore");
const postingsDb = require("../postings/db") as typeof import("../postings/db");
const { runCheckoutReconciliation } = require("./checkoutReconciliation") as typeof import("./checkoutReconciliation");

const realFetch = globalThis.fetch;

before(async () => { await postingsDb._resetDbForTests(); await entitlements._resetDbForTests(); });
beforeEach(async () => { await postingsDb._resetDbForTests(); await entitlements._resetDbForTests(); });
after(async () => {
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

/** Fakes only Authorize.net; records every request so charges can be counted exactly. */
function interceptAuthorizeNet(t: any, opts: { paymentProfileIds: string[]; chargeResponseCode?: string }) {
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (!/apitest\.authorize\.net/.test(url)) return realFetch(url, init);
    const body = JSON.parse(init.body as string);
    calls.push(body);
    if (body.getCustomerProfileRequest) {
      const ids = opts.paymentProfileIds;
      return new Response(JSON.stringify({
        getCustomerProfileResponse: {
          // Exercises Authorize.net's real shapes: absent when none, a bare object when exactly one.
          profile: ids.length === 0 ? {} : { paymentProfiles: ids.length === 1 ? { customerPaymentProfileId: ids[0] } : ids.map((id) => ({ customerPaymentProfileId: id })) },
          messages: { resultCode: "Ok", message: [] },
        },
      }), { status: 200 });
    }
    if (body.createTransactionRequest) {
      return new Response(JSON.stringify({
        createTransactionResponse: {
          transactionResponse: { transId: "txn-recon", responseCode: opts.chargeResponseCode ?? "1" },
          messages: { resultCode: "Ok", message: [] },
        },
      }), { status: 200 });
    }
    if (body.ARBCreateSubscriptionRequest) {
      return new Response(JSON.stringify({ ARBCreateSubscriptionResponse: { subscriptionId: "sub-recon", messages: { resultCode: "Ok", message: [] } } }), { status: 200 });
    }
    throw new Error("unexpected Authorize.net call: " + JSON.stringify(body));
  });
  return calls;
}

const chargeCount = (calls: any[]) => calls.filter((c) => c.createTransactionRequest).length;

/** Backdates a checkout so the sweep considers it old enough to be a missed webhook. */
async function ageCheckout(id: string, minutes: number) {
  await entitlements._withPoolForTests((pool) =>
    pool.query(`UPDATE checkout_sessions SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, String(minutes)])
  );
}

test("a saved card whose webhook never arrived is charged once and activates the membership", async (t) => {
  const phone = "15558880001";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-missed");
  await ageCheckout(session.id, 30);
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-missed"] });

  const result = await runCheckoutReconciliation();
  assert.deepEqual(
    { scanned: result.scanned, activated: result.activated, declined: result.declined, noCardSaved: result.noCardSaved },
    { scanned: 1, activated: 1, declined: 0, noCardSaved: 0 }
  );
  assert.equal(chargeCount(calls), 1, "exactly one charge");

  const entitlement = await entitlements.getEntitlement(phone);
  assert.equal(entitlement.plan, "tier1");
  assert.equal(entitlement.authnetSubscriptionId, "sub-recon");
  assert.equal((await entitlements.getCheckoutSession(session.id))?.status, "completed");
});

test("a second sweep never charges an already-recovered checkout again", async (t) => {
  const phone = "15558880002";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-twice");
  await ageCheckout(session.id, 30);
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-twice"] });

  await runCheckoutReconciliation();
  const second = await runCheckoutReconciliation();

  assert.equal(chargeCount(calls), 1, "the second sweep must not charge again");
  assert.equal(second.scanned, 0, "a completed checkout is no longer swept");
});

test("a checkout already claimed by the webhook is skipped rather than charged in parallel", async (t) => {
  const phone = "15558880003";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-claimed");
  await ageCheckout(session.id, 30);
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-claimed"] });

  // The webhook gets there first and holds the claim.
  const claimed = await entitlements.claimCheckoutSessionForActivation(session.id);
  assert.ok(claimed, "precondition: the webhook won the claim");

  const result = await runCheckoutReconciliation();
  assert.equal(result.skipped, 1);
  assert.equal(chargeCount(calls), 0, "the sweep must not charge a checkout it does not own");
});

test("two concurrent activators produce exactly one charge", async (t) => {
  const phone = "15558880004";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-race");
  await ageCheckout(session.id, 30);
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-race"] });

  const [a, b] = await Promise.all([runCheckoutReconciliation(), runCheckoutReconciliation()]);
  assert.equal(chargeCount(calls), 1, "a race must never double-charge the customer");
  assert.equal(a.activated + b.activated, 1, "exactly one sweep activates");
  assert.equal((await entitlements.getEntitlement(phone)).plan, "tier1");
});

test("a hosted page opened but never completed is left alone for a later sweep", async (t) => {
  const phone = "15558880005";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-nocard");
  await ageCheckout(session.id, 30);
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: [] });

  const result = await runCheckoutReconciliation();
  assert.equal(result.noCardSaved, 1);
  assert.equal(chargeCount(calls), 0);
  assert.equal((await entitlements.getEntitlement(phone)).plan, null);

  const stored = await entitlements.getCheckoutSession(session.id);
  assert.equal(stored?.status, "pending", "still pending — the customer may yet finish");
  // The claim was released, so the next sweep can pick it up rather than waiting out the window.
  assert.ok(await entitlements.claimCheckoutSessionForActivation(session.id), "the claim must have been released");
});

test("a checkout younger than the age threshold is not swept, so a healthy webhook always wins", async (t) => {
  const phone = "15558880006";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-young");
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-young"] });

  const result = await runCheckoutReconciliation();
  assert.equal(result.scanned, 0);
  assert.equal(chargeCount(calls), 0);
  assert.equal((await entitlements.getCheckoutSession(session.id))?.status, "pending");
});

test("an account already activated by a late webhook resolves its checkout without a second charge", async (t) => {
  const phone = "15558880007";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-late");
  await ageCheckout(session.id, 30);
  await entitlements.activateMembership(phone, "tier1", { customerProfileId: "cp-late", paymentProfileId: "pp-late", subscriptionId: "sub-late" });
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-late"] });

  const result = await runCheckoutReconciliation();
  assert.equal(result.alreadyActive, 1);
  assert.equal(chargeCount(calls), 0, "an active membership must never be charged again");
  assert.equal((await entitlements.getCheckoutSession(session.id))?.status, "completed");
});

test("a declined recovery marks the checkout failed and activates nothing", async (t) => {
  const phone = "15558880008";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-declined");
  await ageCheckout(session.id, 30);
  interceptAuthorizeNet(t, { paymentProfileIds: ["pp-declined"], chargeResponseCode: "2" });

  const result = await runCheckoutReconciliation();
  assert.equal(result.declined, 1);
  assert.equal(result.activated, 0);
  assert.equal((await entitlements.getEntitlement(phone)).plan, null);
  assert.equal((await entitlements.getCheckoutSession(session.id))?.status, "failed");
});

test("a checkout that never reached the hosted page has no profile to query and is not scanned", async (t) => {
  const phone = "15558880009";
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await ageCheckout(session.id, 30); // no setCheckoutSessionProfileId — the link was never opened
  const calls = interceptAuthorizeNet(t, { paymentProfileIds: ["pp-never"] });

  const result = await runCheckoutReconciliation();
  assert.equal(result.scanned, 0);
  assert.equal(chargeCount(calls), 0);
});
