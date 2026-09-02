import crypto from "crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-authorizenet-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test-webhook-token";
process.env.WHAPI_TOKEN = "";
process.env.AUTHORIZENET_API_LOGIN_ID = "test-login-id";
process.env.AUTHORIZENET_TRANSACTION_KEY = "test-transaction-key";
process.env.AUTHORIZENET_SIGNATURE_KEY = "test-signature-key";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createServer } = require("./server") as typeof import("./server");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("./watchfacts/inventoryDb") as typeof import("./watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("./billing/entitlementStore") as typeof import("./billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withSchema } = require("./postings/db") as typeof import("./postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./conversation/flow") as typeof import("./conversation/flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./conversation/stateStore") as typeof import("./conversation/stateStore");

const app = createServer();
let httpServer: Server;
let baseUrl = "";
const realFetch = globalThis.fetch;

before(async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

/** Passes local-server requests straight through to the real fetch; fakes only calls to
 *  Authorize.net's sandbox API so tests never hit the real network. */
function interceptAuthorizeNet(t: any, handler: (body: any) => any) {
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (!/apitest\.authorize\.net/.test(url)) return realFetch(url, init);
    const body = JSON.parse(init.body as string);
    calls.push(body);
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  });
  return calls;
}

function signedWebhookRequest(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = "sha512=" + crypto.createHmac("sha512", "test-signature-key").update(raw).digest("hex");
  return { raw, signature };
}

test("GET /pay/:id returns 404 for an unknown checkout session", async () => {
  const res = await fetch(`${baseUrl}/pay/does-not-exist`);
  assert.equal(res.status, 404);
});

test("GET /pay/:id creates a CIM profile, stores its id on the session, and returns an auto-submitting form posting the hosted-profile token to Authorize.net", async (t) => {
  const calls = interceptAuthorizeNet(t, (body) => {
    if (body.createCustomerProfileRequest) {
      return { createCustomerProfileResponse: { customerProfileId: "cp-fresh-1", messages: { resultCode: "Ok", message: [] } } };
    }
    return { getHostedProfilePageResponse: { token: "hpp-token-xyz", messages: { resultCode: "Ok", message: [] } } };
  });
  const session = await entitlements.createCheckoutSession("15551230000", "tier1");

  const res = await fetch(`${baseUrl}/pay/${session.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /action="https:\/\/test\.authorize\.net\/customer\/manage"/);
  assert.match(html, /value="hpp-token-xyz"/);
  assert.equal(calls.length, 2, "createCustomerProfileRequest then getHostedProfilePageRequest");

  const stored = await entitlements.getCheckoutSession(session.id);
  assert.equal(stored?.authnetCustomerProfileId, "cp-fresh-1");
});

test("GET /pay/:id refuses a session that has already been completed", async () => {
  const session = await entitlements.createCheckoutSession("15551230001", "tier1");
  await entitlements.markCheckoutSessionStatus(session.id, "completed", "txn-already");

  const res = await fetch(`${baseUrl}/pay/${session.id}`);
  const text = await res.text();
  assert.match(text, /already been used/);
});

test("POST /webhook/authorizenet rejects a missing or tampered signature", async () => {
  const { raw } = signedWebhookRequest({ eventType: "net.authorize.customer.paymentProfile.created", payload: { id: "1" } });

  const missing = await fetch(`${baseUrl}/webhook/authorizenet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": "sha512=" + "0".repeat(128) },
    body: raw,
  });
  assert.equal(wrong.status, 401);
});

test("a paymentProfile.created webhook charges month 1, activates the membership, sets up ARB, and records a real billing_ledger charge", async (t) => {
  const session = await entitlements.createCheckoutSession("15559990001", "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-1");
  const calls = interceptAuthorizeNet(t, (body) => {
    if (body.createTransactionRequest) {
      return {
        createTransactionResponse: { transactionResponse: { transId: "txn-1", responseCode: "1" }, messages: { resultCode: "Ok", message: [] } },
      };
    }
    if (body.ARBCreateSubscriptionRequest) {
      return { ARBCreateSubscriptionResponse: { subscriptionId: "sub-live-1", messages: { resultCode: "Ok", message: [] } } };
    }
    throw new Error("unexpected Authorize.net call in test: " + JSON.stringify(body));
  });

  const { raw, signature } = signedWebhookRequest({
    notificationId: "note-1",
    eventType: "net.authorize.customer.paymentProfile.created",
    payload: { id: "pp-1", entityName: "customerPaymentProfile", customerProfileId: "cp-1" },
  });
  const res = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": signature },
    body: raw,
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 2, "createTransactionRequest then ARBCreateSubscriptionRequest");

  const entitlement = await entitlements.getEntitlement("15559990001");
  assert.equal(entitlement.plan, "tier1");
  assert.equal(entitlement.authnetCustomerProfileId, "cp-1");
  assert.equal(entitlement.authnetSubscriptionId, "sub-live-1");

  const completedSession = await entitlements.getCheckoutSession(session.id);
  assert.equal(completedSession?.status, "completed");
  assert.equal(completedSession?.authnetTransId, "txn-1");

  const ledger = (await withSchema((pool: any) => pool.query("SELECT amount_cents, billing_status FROM billing_ledger WHERE billing_status='membership_payment'"))) as {
    rows: { amount_cents: number; billing_status: string }[];
  };
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].amount_cents, 5000);
});

test("a paymentProfile.created webhook for a declined card marks the checkout session failed and never activates anything", async (t) => {
  const session = await entitlements.createCheckoutSession("15559990003", "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-declined");
  interceptAuthorizeNet(t, (body) => {
    if (body.createTransactionRequest) {
      return {
        createTransactionResponse: { transactionResponse: { transId: "txn-declined", responseCode: "2" }, messages: { resultCode: "Ok", message: [] } },
      };
    }
    throw new Error("no ARB call should happen for a declined card: " + JSON.stringify(body));
  });

  const { raw, signature } = signedWebhookRequest({
    notificationId: "note-3",
    eventType: "net.authorize.customer.paymentProfile.created",
    payload: { id: "pp-declined", entityName: "customerPaymentProfile", customerProfileId: "cp-declined" },
  });
  const res = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": signature },
    body: raw,
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  const entitlement = await entitlements.getEntitlement("15559990003");
  assert.equal(entitlement.plan, null, "a declined card must never activate a membership");

  const failedSession = await entitlements.getCheckoutSession(session.id);
  assert.equal(failedSession?.status, "failed");
});

test("a subscription-cancelled webhook clears the plan and marks canceled_at", async (t) => {
  interceptAuthorizeNet(t, () => {
    throw new Error("no Authorize.net API call should happen for a cancellation event");
  });
  await entitlements.activateMembership("15559990002", "tier2", {
    customerProfileId: "cp-2",
    paymentProfileId: "pp-2",
    subscriptionId: "sub-live-2",
  });

  const { raw, signature } = signedWebhookRequest({
    notificationId: "note-2",
    eventType: "net.authorize.customer.subscription.cancelled",
    payload: { id: "sub-live-2", entityName: "subscription" },
  });
  const res = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": signature },
    body: raw,
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  const entitlement = await entitlements.getEntitlement("15559990002");
  assert.equal(entitlement.plan, null);
  assert.ok(entitlement.canceledAt);
  assert.equal(entitlement.authnetSubscriptionId, "sub-live-2", "kept as a record of what was canceled");
});

/**
 * Live report: "join said paid but status shows 0/3". Tracing it end to end showed the webhook
 * path itself activating correctly — and "status" printing the SAME line before and after,
 * because the complimentary allowance is spent ahead of a plan's own allowance and the status
 * reply never mentioned membership at all. A user could not tell an unactivated payment from a
 * perfectly activated one, which is what made the trial counter look like evidence of failure.
 */
test('"status" names an active plan, so it cannot be mistaken for an unactivated payment', async (t) => {
  const phone = "15559990010";
  resetState(phone);
  const session = await entitlements.createCheckoutSession(phone, "tier1");
  await entitlements.setCheckoutSessionProfileId(session.id, "cp-status");

  const before = await handleIncomingMessage(phone, "status");
  assert.match(before.messages[0], /Approved matches: 0\/3/);
  assert.doesNotMatch(before.messages[0], /Membership:/, "no plan yet, so nothing to name");

  interceptAuthorizeNet(t, (body) => {
    if (body.createTransactionRequest) {
      return { createTransactionResponse: { transactionResponse: { transId: "txn-status", responseCode: "1" }, messages: { resultCode: "Ok", message: [] } } };
    }
    if (body.ARBCreateSubscriptionRequest) {
      return { ARBCreateSubscriptionResponse: { subscriptionId: "sub-status", messages: { resultCode: "Ok", message: [] } } };
    }
    throw new Error("unexpected Authorize.net call: " + JSON.stringify(body));
  });
  const { raw, signature } = signedWebhookRequest({
    notificationId: "note-status",
    eventType: "net.authorize.customer.paymentProfile.created",
    payload: { id: "pp-status", entityName: "customerPaymentProfile", customerProfileId: "cp-status" },
  });
  await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": signature },
    body: raw,
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await entitlements.getEntitlement(phone)).plan, "tier1", "precondition: the membership really did activate");

  const after = await handleIncomingMessage(phone, "status");
  assert.match(after.messages[0], /Membership: Tier 1 — active/, "an activated plan must be named");
  assert.notEqual(after.messages[0], before.messages[0], "status must not read identically before and after paying");

  const membership = await handleIncomingMessage(phone, "membership status");
  assert.match(membership.messages[0], /Membership: Tier 1 \(\$50\/month\) — active/);
  assert.match(membership.messages[0], /Approvals this week: 0\/5/);
});

test('"membership status" distinguishes an unconfirmed checkout from never having joined', async () => {
  const never = "15559990011";
  resetState(never);
  const untouched = await handleIncomingMessage(never, "membership status");
  assert.match(untouched.messages[0], /Membership: none active yet/);
  assert.doesNotMatch(untouched.messages[0], /checkout was started/);

  const started = "15559990012";
  resetState(started);
  await entitlements.createCheckoutSession(started, "tier2");
  const pending = await handleIncomingMessage(started, "membership status");
  assert.match(pending.messages[0], /A Tier 2 checkout was started just now and hasn't been confirmed yet/);

  // A declined attempt says so rather than looking like an unfinished one.
  const declined = "15559990013";
  resetState(declined);
  const failedSession = await entitlements.createCheckoutSession(declined, "tier1");
  await entitlements.markCheckoutSessionStatus(failedSession.id, "failed", "txn-declined");
  const reply = await handleIncomingMessage(declined, "membership status");
  assert.match(reply.messages[0], /last Tier 1 payment attempt was declined/);
});
