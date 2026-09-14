import { config } from "../config";
import { NormalizedIncomingMessage } from "./types";

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

// Same reasoning as whapi/client.ts's WHAPI_TIMEOUT_MS: every inbound message for a given phone
// is processed serially (conversation/flow.ts's withPhoneSerialized), so an untimed call here
// would block every later message from that same phone indefinitely on a silent network stall.
const CLOUD_API_TIMEOUT_MS = 10_000;

function apiBase(): string {
  return `${config.channels.whatsappCloud.baseUrl}/${config.channels.whatsappCloud.apiVersion}`;
}

function phonePath(path: string): string {
  return `${apiBase()}/${config.channels.whatsappCloud.phoneNumberId}${path}`;
}

async function post(body: unknown): Promise<any> {
  if (!config.channels.whatsappCloud.accessToken || !config.channels.whatsappCloud.phoneNumberId) {
    console.warn("[whatsappCloud] WHATSAPP_CLOUD_ACCESS_TOKEN/WHATSAPP_CLOUD_PHONE_NUMBER_ID not set — skipping live call to /messages. Payload:", body);
    return { simulated: true };
  }
  const res = await fetch(phonePath("/messages"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.channels.whatsappCloud.accessToken}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...(body as object) }),
    signal: AbortSignal.timeout(CLOUD_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WhatsApp Cloud API /messages failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function sendText(phone: string, message: string): Promise<void> {
  await post({ to: digitsOnly(phone), type: "text", text: { body: message } });
}

/**
 * Business-initiated WhatsApp delivery must use an approved template outside the 24-hour service
 * window — same requirement WHAPI's own sendTemplate documented. `fallbackBody` is accepted only
 * for signature compatibility with campaigns/fiReturning.ts's `typeof sendTemplate` (which used
 * to point at whapi/client.ts's version); the Cloud API template send has no equivalent field.
 */
export async function sendTemplate(
  phone: string,
  name: string,
  language: string,
  parameters: string[],
  _fallbackBody?: string
): Promise<void> {
  await post({
    to: digitsOnly(phone),
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }],
    },
  });
}

/**
 * The Cloud API's /messages endpoint sends an image by reference only — either `image.link` (a
 * public HTTPS URL Meta fetches itself) or `image.id` (a media id from a prior POST to
 * /{phoneNumberId}/media). It never accepts inline base64 the way a received image's own
 * `imageUrl` is now stored (see extractIncomingMessages below, and whapi/client.ts's matching
 * `preview` handling) — so a base64 `data:` URI must be uploaded first to get an id.
 */
async function uploadMedia(dataUri: string): Promise<string> {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUri);
  if (!match) throw new Error("[whatsappCloud] uploadMedia: not a base64 data: URI");
  const [, mimeType, base64] = match;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([Buffer.from(base64, "base64")], { type: mimeType }), "image");
  const res = await fetch(phonePath("/media"), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.channels.whatsappCloud.accessToken}` },
    body: form,
    signal: AbortSignal.timeout(CLOUD_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WhatsApp Cloud API /media upload failed: ${res.status} ${text}`);
  }
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!json?.id) throw new Error("WhatsApp Cloud API /media upload returned no id");
  return json.id;
}

export async function sendBannerImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  if (!config.channels.whatsappCloud.accessToken || !config.channels.whatsappCloud.phoneNumberId) {
    console.warn("[whatsappCloud] WHATSAPP_CLOUD_ACCESS_TOKEN/WHATSAPP_CLOUD_PHONE_NUMBER_ID not set — skipping live call to /media or /messages.");
    return;
  }
  const image = imageUrl.startsWith("data:") ? { id: await uploadMedia(imageUrl) } : { link: imageUrl };
  await post({ to: digitsOnly(phone), type: "image", image: { ...image, caption: caption ?? "" } });
}

/**
 * Meta's official WhatsApp Business Cloud API signs its webhook body the same way this file's
 * caller (server.ts's verifyWhatsAppSignature) already verifies — HMAC-SHA256 over the raw
 * request bytes, keyed by WHATSAPP_APP_SECRET, header x-hub-signature-256 — so no separate
 * verification function is needed here; extraction below assumes the caller already verified it.
 */
interface WhatsAppCloudWebhook {
  object?: string;
  entry?: {
    id: string;
    changes?: {
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id: string }[];
        messages?: {
          from: string;
          id: string;
          timestamp?: string;
          type: string;
          text?: { body: string };
          image?: { id: string; mime_type?: string; caption?: string; sha256?: string };
          document?: { id: string; mime_type?: string; caption?: string; filename?: string };
          location?: { latitude: number; longitude: number; name?: string; address?: string };
        }[];
        // Delivery/read receipts — a change carrying only statuses (no messages) is a routine
        // notification about Fi's OWN outbound sends, not something to act on.
        statuses?: unknown[];
      };
    }[];
  }[];
}

/**
 * Fetches a media object's temporary, Bearer-authenticated download URL (GET /{media-id}), then
 * downloads it (itself still requiring the same Bearer token, and short-lived) and resolves it to
 * a base64 `data:` URI — mirroring the precedent whapi/client.ts's `preview` field already set for
 * WHAPI-received images, so the stored imageUrl never expires and every downstream consumer
 * (postingsStore, matching, notify.ts's photo-forwarding, matching/photoRequests.ts) needs zero
 * changes to keep working regardless of which provider a photo actually arrived through.
 */
async function resolveMediaToDataUri(mediaId: string): Promise<string | undefined> {
  const token = config.channels.whatsappCloud.accessToken;
  if (!token) return undefined;
  try {
    const metaRes = await fetch(`${apiBase()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CLOUD_API_TIMEOUT_MS),
    });
    if (!metaRes.ok) throw new Error(`GET /${mediaId} failed: ${metaRes.status}`);
    const meta = (await metaRes.json().catch(() => null)) as { url?: string; mime_type?: string } | null;
    if (!meta?.url) throw new Error(`GET /${mediaId} returned no url`);
    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CLOUD_API_TIMEOUT_MS),
    });
    if (!fileRes.ok) throw new Error(`media download failed: ${fileRes.status}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const mimeType = meta.mime_type ?? "image/jpeg";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.error(`[whatsappCloud] failed to resolve media ${mediaId}:`, err);
    return undefined;
  }
}

/**
 * Normalizes a Cloud API webhook payload into the same shape whapi/client.ts's
 * extractIncomingMessages and channels/telegram.ts's own version produce, so server.ts's shared
 * processing pipeline doesn't need to know which provider a message came from. Unlike WHAPI,
 * the Cloud API has no concept of WhatsApp groups at all (see config.ts's channels.whatsappCloud
 * comment) — every message here is necessarily a 1:1 conversation, so isGroup is always false.
 * A change carrying only `statuses` (delivery/read receipts on Fi's own sends) or no `messages`
 * at all produces nothing to process, same posture as Telegram's channel-post case.
 */
export async function extractIncomingMessages(body: WhatsAppCloudWebhook): Promise<NormalizedIncomingMessage[]> {
  const out: NormalizedIncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;
      const contactsByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const message of value.messages) {
        const text = message.text?.body ?? message.image?.caption ?? message.document?.caption ?? "";
        const hasImage = message.type === "image" && Boolean(message.image?.id);
        const hasLocation = message.type === "location" && Boolean(message.location);
        // A "reaction" (emoji double-tap on an earlier message) is a bare gesture, not an
        // attempt to communicate anything — same exclusion whapi/client.ts applies, for the same
        // reason (reacting to Fi's own reply must never produce a spurious "I didn't understand
        // that"). Every OTHER content-less type (document, audio, video, sticker, contacts,
        // interactive/button replies, ...) still must reach the flow so its own fallback can
        // respond — same posture as whapi/client.ts's and channels/telegram.ts's catch-all.
        if (message.type === "reaction") continue;

        let imageUrl: string | undefined;
        if (hasImage) imageUrl = await resolveMediaToDataUri(message.image!.id);

        out.push({
          id: `whatsappcloud:${message.id}`,
          phone: digitsOnly(message.from),
          text,
          isGroup: false,
          senderName: contactsByWaId.get(message.from),
          imageUrl,
          location: message.location ? { latitude: message.location.latitude, longitude: message.location.longitude } : undefined,
        });
      }
    }
  }
  return out;
}
