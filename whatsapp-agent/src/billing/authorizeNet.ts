import crypto from "crypto";
import { config } from "../config";
import { MEMBERSHIP_PLANS, PlanKey } from "./plans";

/**
 * Authorize.net integration for real Fi membership payments. Two API products, used together:
 *  - Accept Hosted (getHostedPaymentPageRequest): a hosted, Authorize.net-served payment page
 *    for the FIRST charge, so Fi (and this server) never touches card data — required since Fi
 *    is chat-only and has nowhere of its own to collect a card. See createHostedPaymentPageToken.
 *  - ARB, Automated Recurring Billing (ARBCreateSubscriptionRequest): recurring charges for
 *    month 2 onward, against the payment profile Accept Hosted's first charge creates (profile.
 *    createProfile below) — so Fi never stores card data for renewals either.
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

/** Where the /pay/:id route's auto-submitting form posts the token from createHostedPaymentPageToken. */
export function hostedPaymentFormActionUrl(): string {
  return isSandbox() ? "https://test.authorize.net/payment/payment" : "https://accept.authorize.net/payment/payment";
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

interface UserField {
  name: string;
  value: string;
}

/**
 * checkoutSessionId round-trips through Authorize.net as a userField (not the invoiceNumber,
 * which is length-limited well below a UUID) so the webhook handler can map a completed
 * transaction back to the phone/plan it was for without any other correlation state.
 */
export async function createHostedPaymentPageToken(params: { checkoutSessionId: string; phone: string; plan: PlanKey }): Promise<string> {
  const planDef = MEMBERSHIP_PLANS[params.plan];
  const returnBase = config.publicBaseUrl || "";
  const response = await callAuthorizeNetApi<{ token: string }>("getHostedPaymentPageRequest", {
    transactionRequest: {
      transactionType: "authCaptureTransaction",
      amount: (planDef.priceCents / 100).toFixed(2),
      order: { invoiceNumber: params.checkoutSessionId.slice(0, 20), description: `Fi ${planDef.label} membership` },
      // Auto-creates a CIM customer + payment profile from this first charge, so ARB can bill
      // month 2 onward against customerProfileId/customerPaymentProfileId without Fi ever
      // seeing or storing the card itself.
      profile: { createProfile: true },
      userFields: [
        { name: "checkoutSessionId", value: params.checkoutSessionId } satisfies UserField,
        { name: "phone", value: params.phone } satisfies UserField,
        { name: "plan", value: params.plan } satisfies UserField,
      ],
    },
    hostedPaymentSettings: {
      setting: [
        { settingName: "hostedPaymentButtonOptions", settingValue: JSON.stringify({ text: "Pay" }) },
        { settingName: "hostedPaymentOrderOptions", settingValue: JSON.stringify({ show: true, merchantName: "LuxFi" }) },
        {
          settingName: "hostedPaymentReturnOptions",
          settingValue: JSON.stringify({
            showReceipt: true,
            url: returnBase ? `${returnBase}/pay/complete` : undefined,
            urlText: "Done — return to Fi",
            cancelUrl: returnBase ? `${returnBase}/pay/${params.checkoutSessionId}` : undefined,
            cancelUrlText: "Cancel",
          }),
        },
      ],
    },
  });
  return response.token;
}

export interface AuthorizeNetTransactionDetails {
  transId: string;
  responseCode: string; // "1" = approved
  settleAmountCents: number;
  customerProfileId: string | null;
  customerPaymentProfileId: string | null;
  checkoutSessionId: string | null;
  phone: string | null;
  plan: PlanKey | null;
}

function readUserField(userFields: UserField[] | undefined, name: string): string | null {
  return userFields?.find((f) => f.name === name)?.value ?? null;
}

export async function getTransactionDetails(transId: string): Promise<AuthorizeNetTransactionDetails> {
  const response = await callAuthorizeNetApi<{
    transaction: {
      transId: string;
      responseCode: string;
      settleAmount?: string;
      authAmount?: string;
      profile?: { customerProfileId?: string; customerPaymentProfileId?: string };
      order?: { invoiceNumber?: string };
      userFields?: { userField: UserField[] };
    };
  }>("getTransactionDetailsRequest", { transId });
  const tx = response.transaction;
  const userFields = tx.userFields?.userField;
  const amount = Number(tx.settleAmount ?? tx.authAmount ?? "0");
  return {
    transId: tx.transId,
    responseCode: tx.responseCode,
    settleAmountCents: Math.round(amount * 100),
    customerProfileId: tx.profile?.customerProfileId ?? null,
    customerPaymentProfileId: tx.profile?.customerPaymentProfileId ?? null,
    checkoutSessionId: readUserField(userFields, "checkoutSessionId"),
    phone: readUserField(userFields, "phone"),
    plan: readUserField(userFields, "plan") as PlanKey | null,
  };
}

/**
 * Sets up billing for month 2 onward against the payment profile the hosted page's first
 * charge already created. startDate is one interval out since month 1 was already charged by
 * the hosted transaction itself — ARB must never double-charge the first month.
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
