import crypto from "crypto";
import { config } from "../config";
import { smsIdentity, smsPhoneFromIdentity } from "./identity";
import { NormalizedIncomingMessage } from "./types";

async function callApi(params: URLSearchParams): Promise<void> {
  const { accountSid, authToken } = config.channels.sms;
  if (!accountSid || !authToken) {
    console.warn(`[sms] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — skipping live call. Payload:`, params.toString());
    return;
  }
  const res = await fetch(`${config.channels.sms.apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio send failed: ${res.status} ${text}`);
  }
}

export async function sendText(identity: string, message: string): Promise<void> {
  await callApi(new URLSearchParams({ To: smsPhoneFromIdentity(identity), From: config.channels.sms.fromNumber, Body: message }));
}

export async function sendBannerImage(identity: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await callApi(
    new URLSearchParams({
      To: smsPhoneFromIdentity(identity),
      From: config.channels.sms.fromNumber,
      Body: caption ?? "",
      MediaUrl: imageUrl,
    })
  );
}

/**
 * Verifies Twilio's X-Twilio-Signature header: HMAC-SHA1 over the full request URL with all
 * POST params sorted by key and concatenated as key+value pairs (Twilio's documented
 * algorithm), keyed by the auth token, base64-encoded. Never accept an unverified inbound SMS
 * webhook.
 */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signatureHeader: string | undefined): boolean {
  const authToken = config.channels.sms.authToken;
  if (!authToken || !signatureHeader) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Normalizes a Twilio inbound SMS/MMS webhook's form fields into the same shape whapi/client.ts's
 * extractIncomingMessages produces. SMS has no concept of a group chat, so isGroup is always
 * false. MMS media URLs are already directly downloadable (unlike Telegram's file_id
 * indirection), so no extra resolution call is needed.
 */
export function extractIncomingMessage(params: Record<string, string>): NormalizedIncomingMessage | null {
  const from = params.From;
  const messageSid = params.MessageSid;
  if (!from || !messageSid) return null;
  const numMedia = Number(params.NumMedia ?? "0");
  return {
    id: messageSid,
    phone: smsIdentity(from),
    text: (params.Body ?? "").trim(),
    isGroup: false,
    imageUrl: numMedia > 0 ? params.MediaUrl0 : undefined,
  };
}
