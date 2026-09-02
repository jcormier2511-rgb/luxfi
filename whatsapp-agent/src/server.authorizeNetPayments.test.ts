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

test("GET /pay/:id fetches a fresh hosted-payment token and returns an auto-submitting form posting it to Authorize.net", async (t) => {
  interceptAuthorizeNet(t, (body) => {
    if (body.createCustomerProfileRequest) {
      return { createCustomerProfileResponse: { customerProfileId: "cp-fresh-1", messages: { resultCode: "Ok", message: [] } } };
    }
    return { getHostedPaymentPageResponse: { token: "hpp-token-xyz", messages: { resultCode: "Ok", message: [] } } };
  });
  const session = await entitlements.createCheckoutSession("15551230000", "tier1");

  const res = await fetch(`${baseUrl}/pay/${session.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /action="https:\/\/test\.authorize\.net\/payment\/payment"/);
  assert.match(html, /value="hpp-token-xyz"/);
});

test("GET /pay/:id refuses a session that has already been completed", async () => {
  const session = await entitlements.createCheckoutSession("15551230001", "tier1");
  await entitlements.markCheckoutSessionStatus(session.id, "completed", "txn-already");

  const res = await fetch(`${baseUrl}/pay/${session.id}`);
  const text = await res.text();
  assert.match(text, /already been used/);
});

test("POST /webhook/authorizenet rejects a missing or tampered signature", async () => {
  const { raw } = signedWebhookRequest({ eventType: "net.authorize.payment.authcapture.created", payload: { id: "1" } });

  const missing = await fetch(`${baseUrl}/webhook/authorizenet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": "sha512=" + "0".repeat(128) },
    body: raw,
  });
  assert.equal(wrong.status, 401);
});

test("a successful authcapture webhook activates the membership, sets up ARB, and records a real billing_ledger charge", async (t) => {
  const session = await entitlements.createCheckoutSession("15559990001", "tier1");
  const calls = interceptAuthorizeNet(t, (body) => {
    if (body.getTransactionDetailsRequest) {
      return {
        getTransactionDetailsResponse: {
          messages: { resultCode: "Ok", message: [] },
          transaction: {
            transId: "txn-1",
            responseCode: "1",
            settleAmount: "50.00",
            profile: { customerProfileId: "cp-1", customerPaymentProfileId: "pp-1" },
            order: { invoiceNumber: session.id },
          },
        },
      };
    }
    if (body.ARBCreateSubscriptionRequest) {
      return { ARBCreateSubscriptionResponse: { subscriptionId: "sub-live-1", messages: { resultCode: "Ok", message: [] } } };
    }
    throw new Error("unexpected Authorize.net call in test: " + JSON.stringify(body));
  });

  const { raw, signature } = signedWebhookRequest({
    notificationId: "note-1",
    eventType: "net.authorize.payment.authcapture.created",
    payload: { id: "txn-1", entityName: "transaction" },
  });
  const res = await fetch(`${baseUrl}/webhook/authorizenet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-anet-signature": signature },
    body: raw,
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 2, "getTransactionDetailsRequest then ARBCreateSubscriptionRequest");

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
