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
  hostedProfilePageFormActionUrl,
  createCustomerProfile,
  createHostedProfilePageToken,
  createProfileTransaction,
  createArbSubscription,
  cancelArbSubscription,
  verifyWebhookSignature,
} = authorizeNet;

test("isAuthorizeNetConfigured is true once an API login id and transaction key are set", () => {
  assert.equal(isAuthorizeNetConfigured(), true);
});

test("hostedProfilePageFormActionUrl defaults to the sandbox host (AUTHORIZENET_ENVIRONMENT unset)", () => {
  assert.equal(hostedProfilePageFormActionUrl(), "https://test.authorize.net/customer/manage");
});

test("createCustomerProfile sends merchantCustomerId and returns the new customerProfileId", async (t) => {
  let sentBody: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ createCustomerProfileResponse: { customerProfileId: "cp-new-1", messages: { resultCode: "Ok", message: [] } } }), {
      status: 200,
    });
  });

  const customerProfileId = await createCustomerProfile("sess-1");
  assert.equal(customerProfileId, "cp-new-1");
  assert.equal(sentBody.createCustomerProfileRequest.merchantAuthentication.name, "test-login-id");
  assert.equal(sentBody.createCustomerProfileRequest.profile.merchantCustomerId, "sess-1");
});

test("createCustomerProfile recovers from E00039 (revisiting the same /pay/:id link) by reusing the already-created profile id", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          createCustomerProfileResponse: {
            messages: { resultCode: "Error", message: [{ code: "E00039", text: "A duplicate record with ID 527669620 already exists." }] },
          },
        }),
        { status: 200 }
      )
  );
  const customerProfileId = await createCustomerProfile("sess-revisit");
  assert.equal(customerProfileId, "527669620", "must reuse the id parsed out of the E00039 message rather than throwing");
});

test("createHostedProfilePageToken sends the customerProfileId and a plain-ASCII return-url setting", async (t) => {
  let sentBody: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ getHostedProfilePageResponse: { token: "hpp-token-abc", messages: { resultCode: "Ok", message: [] } } }), {
      status: 200,
    });
  });

  const token = await createHostedProfilePageToken({ customerProfileId: "cp-1", checkoutSessionId: "sess-1" });
  assert.equal(token, "hpp-token-abc");

  const req = sentBody.getHostedProfilePageRequest;
  assert.equal(req.merchantAuthentication.name, "test-login-id");
  assert.equal(req.customerProfileId, "cp-1");
  const settings: { settingName: string; settingValue: string }[] = req.hostedProfileSettings.setting;
  assert.equal(settings.find((s) => s.settingName === "hostedProfileReturnUrl")?.settingValue, "https://fi.example.com/pay/complete");
  assert.doesNotMatch(settings.find((s) => s.settingName === "hostedProfileReturnUrlText")!.settingValue, /—/, "no non-ASCII characters (E00013 was rejected live for this before)");
});

test("createProfileTransaction charges the plan's dollar amount against the given profile and reports responseCode as-is (approved or declined)", async (t) => {
  let sentBody: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        createTransactionResponse: { transactionResponse: { transId: "txn-1", responseCode: "1" }, messages: { resultCode: "Ok", message: [] } },
      }),
      { status: 200 }
    );
  });

  const result = await createProfileTransaction({ plan: "tier2", customerProfileId: "cp-1", customerPaymentProfileId: "pp-1" });
  assert.equal(result.transId, "txn-1");
  assert.equal(result.responseCode, "1");
  assert.equal(result.settleAmountCents, 15000, "tier2 is $150/month");

  const req = sentBody.createTransactionRequest.transactionRequest;
  assert.equal(req.amount, "150.00");
  assert.equal(req.profile.customerProfileId, "cp-1");
  assert.equal(req.profile.paymentProfile.paymentProfileId, "pp-1");
});

test("createProfileTransaction surfaces a declined card (responseCode 2) as a normal result, not a thrown error", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          createTransactionResponse: { transactionResponse: { transId: "txn-declined", responseCode: "2" }, messages: { resultCode: "Ok", message: [] } },
        }),
        { status: 200 }
      )
  );
  const result = await createProfileTransaction({ plan: "tier1", customerProfileId: "cp-1", customerPaymentProfileId: "pp-1" });
  assert.equal(result.responseCode, "2");
});

test("callAuthorizeNetApi throws with the API's own error detail when resultCode is Error", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          getHostedProfilePageResponse: { messages: { resultCode: "Error", message: [{ code: "E00027", text: "The transaction was unsuccessful." }] } },
        }),
        { status: 200 }
      )
  );
  await assert.rejects(
    () => createHostedProfilePageToken({ customerProfileId: "cp-1", checkoutSessionId: "sess-2" }),
    /E00027: The transaction was unsuccessful\./
  );
});

test("callAuthorizeNetApi strips a leading BOM before parsing JSON", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("﻿" + JSON.stringify({ getHostedProfilePageResponse: { token: "bom-ok", messages: { resultCode: "Ok", message: [] } } }), {
        status: 200,
      })
  );
  const token = await createHostedProfilePageToken({ customerProfileId: "cp-1", checkoutSessionId: "sess-3" });
  assert.equal(token, "bom-ok");
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
  const body = Buffer.from(JSON.stringify({ eventType: "net.authorize.customer.paymentProfile.created" }));
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
