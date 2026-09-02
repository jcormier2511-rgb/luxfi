import { sendText as whapiSendText, sendBannerImage as whapiSendBannerImage } from "../whapi/client";
import * as telegram from "./telegram";
import * as sms from "./sms";
import { platformForIdentity } from "./identity";
import { config, isOutboundUnrestricted, isOutboundRecipientAllowed } from "../config";

export { platformForIdentity, telegramIdentity, smsIdentity } from "./identity";
export type { NormalizedIncomingMessage } from "./types";

/**
 * Testing-in-production safety valve (RESTRICT_OUTBOUND_TO, see config.ts) — when set, every
 * outbound send not addressed to an allowed identity is redirected to the first allowed one
 * instead, tagged with who it would really have gone to. Returns the identity/message to
 * actually send; a no-op (identity/message unchanged) when unrestricted or already allowed.
 */
function applyOutboundRestriction(identity: string, message: string): { identity: string; message: string } {
  if (isOutboundUnrestricted() || isOutboundRecipientAllowed(identity)) return { identity, message };
  const redirectTo = config.channels.restrictOutboundTo[0];
  return { identity: redirectTo, message: `[Redirected — was for ${identity} via ${platformForIdentity(identity)}]\n\n${message}` };
}

/**
 * Single send entry point for every part of the app that used to import sendText directly from
 * whapi/client — dispatches by the identity string's platform prefix (see channels/identity.ts)
 * so call sites never need to know or care which channel a given contact is actually on.
 */
export async function sendText(identity: string, message: string): Promise<void> {
  const target = applyOutboundRestriction(identity, message);
  switch (platformForIdentity(target.identity)) {
    case "telegram":
      return telegram.sendText(target.identity, target.message);
    case "sms":
      return sms.sendText(target.identity, target.message);
    default:
      return whapiSendText(target.identity, target.message);
  }
}

export async function sendBannerImage(identity: string, imageUrl: string, caption?: string): Promise<void> {
  const target = applyOutboundRestriction(identity, caption ?? "");
  const targetCaption = target.message || undefined;
  switch (platformForIdentity(target.identity)) {
    case "telegram":
      return telegram.sendBannerImage(target.identity, imageUrl, targetCaption);
    case "sms":
      return sms.sendBannerImage(target.identity, imageUrl, targetCaption);
    default:
      return whapiSendBannerImage(target.identity, imageUrl, targetCaption);
  }
}
