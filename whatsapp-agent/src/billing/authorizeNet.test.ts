import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Must be set before config.ts (and therefore authorizeNet.ts) is first required — same
// convention as entitlementStore.test.ts/config.aiMatching.*.test.ts. Each test file gets its
// own process under `node --test`, so these never leak into other test files.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.AUTHORIZENET_API_LOGIN_ID = "test-login-id";
process.env.AUTHORIZENET_TRANSACTION_KEY = "test-transaction-key";
process.env.AUTHORIZENET_SIGNATURE_KEY = "test-signature-key";
process.env.PUBLIC_BASE_URL = "https://fi.example.com";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authorizeNet = require("./authorizeNet") as typeof import("./authorizeNet");
const {
  isAuthorizeNetConfigured,
  hostedPaymentFormActionUrl,
  createHostedPaymentPageToken,
  getTransactionDetails,
  createArbSubscription,
  cancelArbSubscription,
  verifyWebhookSignature,
} = authorizeNet;

test("isAuthorizeNetConfigured is true once an API login id and transaction key are set", () => {
  assert.equal(isAuthorizeNetConfigured(), true);
});

test("hostedPaymentFormActionUrl defaults to the sandbox host (AUTHORIZENET_ENVIRONMENT unset)", () => {
  assert.equal(hostedPaymentFormActionUrl(), "https://test.authorize.net/payment/payment");
});

test("createHostedPaymentPageToken pre-creates an empty CIM profile, references it by id, sends the correlation invoiceNumber, and enables Accept Hosted's own profile-attach setting", async (t) => {
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    if (body.createCustomerProfileRequest) {
      return new Response(JSON.stringify({ createCustomerProfileResponse: { customerProfileId: "cp-new-1", messages: { resultCode: "Ok", message: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ getHostedPaymentPageResponse: { token: "hpp-token-abc", messages: { resultCode: "Ok", message: [] } } }), { status: 200 });
  });

  const token = await createHostedPaymentPageToken({ checkoutSessionId: "sess-1", phone: "15551234567", plan: "tier2" });
  assert.equal(token, "hpp-token-abc");
  assert.equal(calls.length, 2, "createCustomerProfileRequest then getHostedPaymentPageRequest");
  assert.equal(calls[0].createCustomerProfileRequest.profile.merchantCustomerId, "sess-1");

  const req = calls[1].getHostedPaymentPageRequest;
  assert.equal(req.merchantAuthentication.name, "test-login-id");
  assert.equal(req.merchantAuthentication.transactionKey, "test-transaction-key");
  assert.equal(req.transactionRequest.amount, "150.00", "tier2 is $150/month");
  assert.equal(req.transactionRequest.profile.customerProfileId, "cp-new-1", "must reference the pre-created profile, not createProfile:true");
  assert.equal(req.transactionRequest.order.invoiceNumber, "sess-1", "checkoutSessionId round-trips as order.invoiceNumber, not a userField");
  const settings: { settingName: string; settingValue: string }[] = req.hostedPaymentSettings.setting;
  const customerOptions = JSON.parse(settings.find((s) => s.settingName === "hostedPaymentCustomerOptions")!.settingValue);
  assert.equal(customerOptions.addPaymentProfile, true, "must ask Accept Hosted to attach the entered card to the pre-created profile");
});

test("createHostedPaymentPageToken recovers from E00039 (revisiting the same /pay/:id link) by reusing the already-created profile id", async (t) => {
  let sentToken: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.createCustomerProfileRequest) {
      return new Response(
        JSON.stringify({
          createCustomerProfileResponse: {
            messages: { resultCode: "Error", message: [{ code: "E00039", text: "A duplicate record with ID 527669620 already exists." }] },
          },
        }),
        { status: 200 }
      );
    }
    sentToken = body.getHostedPaymentPageRequest;
    return new Response(JSON.stringify({ getHostedPaymentPageResponse: { token: "hpp-token-reuse", messages: { resultCode: "Ok", message: [] } } }), {
      status: 200,
    });
  });

  const token = await createHostedPaymentPageToken({ checkoutSessionId: "sess-revisit", phone: "15551234567", plan: "tier1" });
  assert.equal(token, "hpp-token-reuse", "a second visit to the same link must still succeed, not throw");
  assert.equal(sentToken.transactionRequest.profile.customerProfileId, "527669620", "must reuse the id parsed out of the E00039 message");
});

test("callAuthorizeNetApi throws with the API's own error detail when resultCode is Error", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          getHostedPaymentPageResponse: { messages: { resultCode: "Error", message: [{ code: "E00027", text: "The transaction was unsuccessful." }] } },
        }),
        { status: 200 }
      )
  );
  await assert.rejects(
    () => createHostedPaymentPageToken({ checkoutSessionId: "sess-2", phone: "15551234567", plan: "tier1" }),
    /E00027: The transaction was unsuccessful\./
  );
});

test("callAuthorizeNetApi strips a leading BOM before parsing JSON", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("﻿" + JSON.stringify({ getHostedPaymentPageResponse: { token: "bom-ok", messages: { resultCode: "Ok", message: [] } } }), {
        status: 200,
      })
  );
  const token = await createHostedPaymentPageToken({ checkoutSessionId: "sess-3", phone: "15551234567", plan: "tier1" });
  assert.equal(token, "bom-ok");
});

test("getTransactionDetails parses the approved response into settleAmountCents and the correlation invoiceNumber", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          getTransactionDetailsResponse: {
            messages: { resultCode: "Ok", message: [] },
            transaction: {
              transId: "40012345",
              responseCode: "1",
              settleAmount: "50.00",
              profile: { customerProfileId: "cp-1", customerPaymentProfileId: "pp-1" },
              order: { invoiceNumber: "sess-4" },
            },
          },
        }),
        { status: 200 }
      )
  );
  const details = await getTransactionDetails("40012345");
  assert.equal(details.transId, "40012345");
  assert.equal(details.responseCode, "1");
  assert.equal(details.settleAmountCents, 5000);
  assert.equal(details.customerProfileId, "cp-1");
  assert.equal(details.customerPaymentProfileId, "pp-1");
  assert.equal(details.checkoutSessionId, "sess-4");
});

test("createArbSubscription requests month-2-onward billing against the given payment profile and returns the subscriptionId", async (t) => {
  let sentBody: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ARBCreateSubscriptionResponse: { subscriptionId: "sub-99", messages: { resultCode: "Ok", message: [] } } }), {
      status: 200,
    });
  });
  const subscriptionId = await createArbSubscription({ plan: "tier3", customerProfileId: "cp-2", customerPaymentProfileId: "pp-2" });
  assert.equal(subscriptionId, "sub-99");
  const sub = sentBody.ARBCreateSubscriptionRequest.subscription;
  assert.equal(sub.amount, "300.00", "tier3 is $300/month");
  assert.equal(sub.profile.customerProfileId, "cp-2");
  assert.equal(sub.profile.customerPaymentProfileId, "pp-2");
  assert.equal(sub.paymentSchedule.interval.length, 1);
  assert.equal(sub.paymentSchedule.interval.unit, "months");
});

test("cancelArbSubscription posts ARBCancelSubscriptionRequest with the given subscriptionId", async (t) => {
  let sentBody: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ARBCancelSubscriptionResponse: { messages: { resultCode: "Ok", message: [] } } }), { status: 200 });
  });
  await cancelArbSubscription("sub-42");
  assert.equal(sentBody.ARBCancelSubscriptionRequest.subscriptionId, "sub-42");
});

test("verifyWebhookSignature accepts a correctly-signed body and rejects a tampered one or a missing header", () => {
  const body = Buffer.from(JSON.stringify({ eventType: "net.authorize.payment.authcapture.created" }));
  const validSig = "sha512=" + crypto.createHmac("sha512", "test-signature-key").update(body).digest("hex");

  assert.equal(verifyWebhookSignature(body, validSig), true);
  assert.equal(verifyWebhookSignature(body, undefined), false);
  assert.equal(verifyWebhookSignature(Buffer.from("tampered body"), validSig), false);
  assert.equal(verifyWebhookSignature(body, "sha512=" + "0".repeat(128)), false);
});

test("verifyWebhookSignature also accepts the bare hex signature without the sha512= prefix", () => {
  const body = Buffer.from("some body");
  const bareSig = crypto.createHmac("sha512", "test-signature-key").update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, bareSig), true);
});
