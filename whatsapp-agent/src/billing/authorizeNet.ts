import crypto from "crypto";
import { config } from "../config";
import { MEMBERSHIP_PLANS, PlanKey } from "./plans";

/**
 * Authorize.net integration for real Fi membership payments. Three API products, used together:
 *  - CIM's Hosted Profile Page (getHostedProfilePageRequest): a hosted, Authorize.net-served
 *    page whose ONLY job is securely capturing a card into a payment profile -- no charge
 *    happens on that page at all. Required since Fi is chat-only and has nowhere of its own to
 *    collect a card; chosen over Accept Hosted's checkout page (which combines "pay now" with
 *    an optional "save this card" step) after live testing showed that optional step reliably
 *    never fires, with no way from this side to force or verify it -- see
 *    createHostedProfilePageToken.
 *  - Once the resulting net.authorize.customer.paymentProfile.created webhook confirms a card
 *    was actually saved, this server charges month 1 itself via createTransactionRequest
 *    against that saved profile (createProfileTransaction) -- no hosted page involved, since
 *    charging an already-saved profile is a plain server-to-server call.
 *  - ARB, Automated Recurring Billing (ARBCreateSubscriptionRequest): recurring charges for
 *    month 2 onward, against the same profile.
 * Every exported call is a no-op/throw behind isAuthorizeNetConfigured() — see config.ts's
 * comment on why an unset key must never attempt a live charge.
 */

export function isAuthorizeNetConfigured(): boolean {
  return Boolean(config.billing.authorizeNet.apiLoginId && config.billing.authorizeNet.transactionKey);
}

function isSandbox(): boolean {
  return config.billing.authorizeNet.environment !== "production";
}

function apiEndpoint(): string {
  return isSandbox() ? "https://apitest.authorize.net/xml/v1/request.api" : "https://api.authorize.net/xml/v1/request.api";
}

/** Where the /pay/:id route's auto-submitting form posts the token from createHostedProfilePageToken. */
export function hostedProfilePageFormActionUrl(): string {
  return isSandbox() ? "https://test.authorize.net/customer/manage" : "https://accept.authorize.net/customer/manage";
}

interface AnetMessages {
  resultCode: "Ok" | "Error";
  message: { code: string; text: string }[];
}

/**
 * Authorize.net's JSON API wraps every request/response in a single key named after the
 * request (e.g. {getHostedPaymentPageRequest: {...}} / {getHostedPaymentPageResponse: {...}}),
 * and sometimes prefixes the response body with a UTF-8 BOM — both handled here so every
 * call site below just gets the inner response object back.
 */
async function callAuthorizeNetApi<T>(requestName: string, body: Record<string, unknown>): Promise<T> {
  if (!isAuthorizeNetConfigured()) {
    throw new Error("Authorize.net is not configured (AUTHORIZENET_API_LOGIN_ID / AUTHORIZENET_TRANSACTION_KEY unset)");
  }
  const res = await fetch(apiEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      [requestName]: {
        merchantAuthentication: {
          name: config.billing.authorizeNet.apiLoginId,
          transactionKey: config.billing.authorizeNet.transactionKey,
        },
        ...body,
      },
    }),
  });
  const rawText = (await res.text()).replace(/^﻿/, "");
  const responseKey = requestName.replace(/Request$/, "Response");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Authorize.net ${requestName} returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
  }
  const responseBody = (parsed[responseKey] ?? parsed) as T & { messages?: AnetMessages };
  const messages = responseBody?.messages;
  if (!res.ok || messages?.resultCode === "Error") {
    const detail = messages?.message?.map((m) => `${m.code}: ${m.text}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Authorize.net ${requestName} failed: ${detail}`);
  }
  return responseBody;
}

/**
 * Creates an empty CIM customer profile (no payment method yet) keyed by merchantCustomerId.
 * checkoutSessionId doubles as merchantCustomerId -- already <=20 chars (the field's limit)
 * and unique per checkout, so no separate id scheme is needed.
 *
 * Idempotent by design, not just in practice: GET /pay/:id calls this fresh on every visit
 * (the hosted-profile-page token itself must be regenerated each time -- it expires after 15
 * minutes -- so a link sitting unread in chat for a day still works), and a second visit to
 * the same link is an expected, normal case, not a bug. Authorize.net rejects the second
 * createCustomerProfileRequest with E00039 ("a duplicate record with ID <id> already exists")
 * since the same merchantCustomerId was already used -- confirmed live. The API has no
 * structured field for the existing id on this error, only the message text, so parsing it out
 * is Authorize.net's own documented recovery path for E00039, not a fragile workaround.
 */
export async function createCustomerProfile(merchantCustomerId: string): Promise<string> {
  try {
    const response = await callAuthorizeNetApi<{ customerProfileId: string }>("createCustomerProfileRequest", {
      profile: { merchantCustomerId },
    });
    return response.customerProfileId;
  } catch (err) {
    const duplicateId = /E00039:.*?ID\s+(\d+)/.exec((err as Error).message)?.[1];
    if (duplicateId) return duplicateId;
    throw err;
  }
}

/**
 * The CIM Hosted Profile Page (customer/manage) -- unlike Accept Hosted's checkout page, this
 * page's ONLY function is capturing a card into the given profile; there's no "pay now" step
 * and no optional checkbox to fail to check, which is exactly why this replaced Accept Hosted
 * here (see this module's top comment). Requires the profile to already exist (createCustomerProfile).
 */
export async function createHostedProfilePageToken(params: { customerProfileId: string; checkoutSessionId: string }): Promise<string> {
  const returnBase = config.publicBaseUrl || "";
  const response = await callAuthorizeNetApi<{ token: string }>("getHostedProfilePageRequest", {
    customerProfileId: params.customerProfileId,
    hostedProfileSettings: {
      setting: [
        // Plain ASCII only -- an em dash previously got rejected live as E00013 "invalid
        // characters" on a different hosted-page setting; kept plain here defensively too.
        { settingName: "hostedProfileReturnUrl", settingValue: returnBase ? `${returnBase}/pay/complete` : "" },
        { settingName: "hostedProfileReturnUrlText", settingValue: "Done - Return to Fi" },
        { settingName: "hostedProfileHeadingBgColor", settingValue: "#0f172a" },
      ],
    },
  });
  return response.token;
}

export interface AuthorizeNetChargeResult {
  transId: string;
  responseCode: string; // "1" = approved, "2" = declined
  settleAmountCents: number;
}

/**
 * Charges a plan's month-1 amount against an already-saved CIM payment profile -- a plain
 * server-to-server call (no hosted page involved), made once the net.authorize.customer.
 * paymentProfile.created webhook confirms the card was actually saved. NOT the same as an API-
 * level failure: a declined card still comes back as a normal (resultCode "Ok") response here,
 * just with transactionResponse.responseCode "2" instead of "1" -- callers must check it.
 */
export async function createProfileTransaction(params: { plan: PlanKey; customerProfileId: string; customerPaymentProfileId: string }): Promise<AuthorizeNetChargeResult> {
  const planDef = MEMBERSHIP_PLANS[params.plan];
  const response = await callAuthorizeNetApi<{
    transactionResponse: { transId: string; responseCode: string };
  }>("createTransactionRequest", {
    transactionRequest: {
      transactionType: "authCaptureTransaction",
      amount: (planDef.priceCents / 100).toFixed(2),
      profile: {
        customerProfileId: params.customerProfileId,
        paymentProfile: { paymentProfileId: params.customerPaymentProfileId },
      },
    },
  });
  return {
    transId: response.transactionResponse.transId,
    responseCode: response.transactionResponse.responseCode,
    settleAmountCents: planDef.priceCents,
  };
}

/**
 * Sets up billing for month 2 onward against the same payment profile createProfileTransaction
 * already charged for month 1. startDate is one interval out since month 1 was already charged
 * directly — ARB must never double-charge the first month.
 */
export async function createArbSubscription(params: { plan: PlanKey; customerProfileId: string; customerPaymentProfileId: string }): Promise<string> {
  const planDef = MEMBERSHIP_PLANS[params.plan];
  const startDate = new Date();
  startDate.setUTCMonth(startDate.getUTCMonth() + 1);
  const response = await callAuthorizeNetApi<{ subscriptionId: string }>("ARBCreateSubscriptionRequest", {
    subscription: {
      name: `Fi ${planDef.label} membership`,
      paymentSchedule: {
        interval: { length: 1, unit: "months" },
        startDate: startDate.toISOString().slice(0, 10),
        totalOccurrences: 9999,
      },
      amount: (planDef.priceCents / 100).toFixed(2),
      profile: {
        customerProfileId: params.customerProfileId,
        customerPaymentProfileId: params.customerPaymentProfileId,
      },
    },
  });
  return response.subscriptionId;
}

export async function cancelArbSubscription(subscriptionId: string): Promise<void> {
  await callAuthorizeNetApi("ARBCancelSubscriptionRequest", { subscriptionId });
}

/**
 * Authorize.net signs each webhook body with HMAC-SHA512 over the raw bytes, keyed by the
 * Signature Key (config.billing.authorizeNet.signatureKey — separate from the API transaction
 * key), sent in the X-ANET-Signature header as "sha512=<hex>" (some accounts send the bare hex
 * without the prefix, so both are accepted here).
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.billing.authorizeNet.signatureKey || !signatureHeader) return false;
  const supplied = signatureHeader.replace(/^sha512=/i, "").trim();
  if (!/^[a-fA-F0-9]{128}$/.test(supplied)) return false;
  const expected = crypto.createHmac("sha512", config.billing.authorizeNet.signatureKey).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export interface AuthorizeNetWebhookEvent {
  notificationId: string;
  eventType: string;
  payload: { id?: string; entityName?: string; [key: string]: unknown };
}
