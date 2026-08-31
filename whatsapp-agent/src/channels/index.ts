import { sendText as whapiSendText, sendBannerImage as whapiSendBannerImage } from "../whapi/client";
import * as telegram from "./telegram";
import * as sms from "./sms";
import { platformForIdentity } from "./identity";

export { platformForIdentity, telegramIdentity, smsIdentity } from "./identity";
export type { NormalizedIncomingMessage } from "./types";

/**
 * Single send entry point for every part of the app that used to import sendText directly from
 * whapi/client — dispatches by the identity string's platform prefix (see channels/identity.ts)
 * so call sites never need to know or care which channel a given contact is actually on.
 */
export async function sendText(identity: string, message: string): Promise<void> {
  switch (platformForIdentity(identity)) {
    case "telegram":
      return telegram.sendText(identity, message);
    case "sms":
      return sms.sendText(identity, message);
    default:
      return whapiSendText(identity, message);
  }
}

export async function sendBannerImage(identity: string, imageUrl: string, caption?: string): Promise<void> {
  switch (platformForIdentity(identity)) {
    case "telegram":
      return telegram.sendBannerImage(identity, imageUrl, caption);
    case "sms":
      return sms.sendBannerImage(identity, imageUrl, caption);
    default:
      return whapiSendBannerImage(identity, imageUrl, caption);
  }
}
