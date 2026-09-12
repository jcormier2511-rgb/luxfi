import { config } from "../config";
import { NormalizedIncomingMessage } from "./types";

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

// Same reasoning as whapi/client.ts's WHAPI_TIMEOUT_MS -- every inbound message for a given
// phone is processed serially (conversation/flow.ts's withPhoneSerialized), so an untimed call
// here would block every later message from that same phone indefinitely on a silent stall.
const GREEN_API_TIMEOUT_MS = 10_000;

function apiBase(): string {
  return `${config.channels.greenApi.baseUrl}/waInstance${config.channels.greenApi.instanceId}`;
}

/** An individual WhatsApp contact's chatId. Unlike WHAPI (which takes bare digits and resolves
 *  the suffix itself), Green API's REST API always requires the full "<digits>@c.us" form. */
function individualChatId(identity: string): string {
  return `${digitsOnly(identity)}@c.us`;
}

/** A WhatsApp GROUP's chatId ("<digits>@g.us") -- kept as its own function, never inferred from
 *  a bare identity the way individualChatId is, so a group send can never be accidentally
 *  misrouted to the same digits as an individual (see sendGroupText/sendGroupBannerImage,
 *  called only from postings/groupPublishing.ts, which already knows which of the two it has). */
function groupChatId(groupId: string): string {
  return `${digitsOnly(groupId)}@g.us`;
}

async function post(path: string, body: unknown): Promise<any> {
  if (!config.channels.greenApi.instanceId || !config.channels.greenApi.apiToken) {
    console.warn(`[greenApi] GREEN_API_INSTANCE_ID/GREEN_API_API_TOKEN not set — skipping live call to ${path}. Payload:`, body);
    return { simulated: true };
  }
  const res = await fetch(`${apiBase()}/${path}/${config.channels.greenApi.apiToken}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GREEN_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Green API ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function sendText(phone: string, message: string): Promise<void> {
  await post("sendMessage", { chatId: individualChatId(phone), message });
}

/** postings/groupPublishing.ts's WhatsApp-group branch — see groupChatId's own comment. Unlike
 *  the official WhatsApp Cloud API (which cannot post into groups at all, by Meta's own design),
 *  Green API can send to a group the same way it sends to an individual, so this and sendText
 *  are the ONE provider covering both cases -- no separate group-only client needed. */
export async function sendGroupText(groupId: string, message: string): Promise<void> {
  await post("sendMessage", { chatId: groupChatId(groupId), message });
}

/**
 * Green API sends a hosted URL by reference (sendFileByUrl) — the same "no upload needed for an
 * already-public link" shortcut whatsappCloud.ts's sendBannerImage takes for `image.link`. A
 * base64 `data:` URI (a photo Fi itself received and re-stores inline — see extractIncomingMessages
 * below, and whapi/client.ts's matching `preview` handling) has no public URL to hand over, so it
 * goes through sendFileByUpload's multipart form instead, mirroring whatsappCloud.ts's own
 * uploadMedia split.
 */
async function sendFile(chatId: string, imageUrl: string, caption?: string): Promise<void> {
  const dataUriMatch = /^data:([^;]+);base64,(.+)$/s.exec(imageUrl);
  if (!dataUriMatch) {
    await post("sendFileByUrl", { chatId, urlFile: imageUrl, fileName: "image.jpg", caption: caption ?? "" });
    return;
  }
  if (!config.channels.greenApi.instanceId || !config.channels.greenApi.apiToken) {
    console.warn("[greenApi] GREEN_API_INSTANCE_ID/GREEN_API_API_TOKEN not set — skipping live call to sendFileByUpload.");
    return;
  }
  const [, mimeType, base64] = dataUriMatch;
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("caption", caption ?? "");
  form.append("file", new Blob([Buffer.from(base64, "base64")], { type: mimeType }), "image.jpg");
  const res = await fetch(`${apiBase()}/sendFileByUpload/${config.channels.greenApi.apiToken}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(GREEN_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Green API sendFileByUpload failed: ${res.status} ${text}`);
  }
}

export async function sendBannerImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await sendFile(individualChatId(phone), imageUrl, caption);
}

export async function sendGroupBannerImage(groupId: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await sendFile(groupChatId(groupId), imageUrl, caption);
}

export interface GreenApiHealthResult {
  configured: boolean;
  reachable: boolean;
  authorized: boolean | null;
  stateInstance: string | null;
  error: string | null;
}

/**
 * Green API's GET getStateInstance reports whether the linked WhatsApp session is actually
 * connected without sending anything, mirroring checkWhapiHealth's role for the admin panel.
 * DOCUMENTED BUT NOT EMPIRICALLY CONFIRMED (same caveat whapi/client.ts's own health/groups
 * calls carry): this sandbox has no live Green API credentials to confirm the response shape
 * against. `{"stateInstance":"authorized"}` is Green API's documented shape as of this writing —
 * verify against a real instance once connected.
 */
export async function checkGreenApiHealth(): Promise<GreenApiHealthResult> {
  if (!config.channels.greenApi.instanceId || !config.channels.greenApi.apiToken) {
    return { configured: false, reachable: false, authorized: null, stateInstance: null, error: null };
  }
  try {
    const res = await fetch(`${apiBase()}/getStateInstance/${config.channels.greenApi.apiToken}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GREEN_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { configured: true, reachable: false, authorized: null, stateInstance: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { stateInstance?: string } | null;
    const stateInstance = body?.stateInstance ?? null;
    return { configured: true, reachable: true, authorized: stateInstance ? stateInstance === "authorized" : null, stateInstance, error: null };
  } catch (err) {
    return { configured: true, reachable: false, authorized: null, stateInstance: null, error: (err as Error).message };
  }
}

/**
 * Shape of the payload Green API POSTs to a configured instance's webhook. Only
 * "incomingMessageReceived" ever carries a real inbound message -- every other typeWebhook
 * (outgoingMessageStatus, outgoingAPIMessageReceived, stateInstanceChanged, deviceInfo,
 * incomingCall, ...) is a routine notification about something other than a message someone
 * sent Fi, same posture whatsappCloud.ts's own "statuses only, no messages" case takes.
 *
 * DOCUMENTED BUT NOT EMPIRICALLY CONFIRMED (same caveat as checkGreenApiHealth above) -- the
 * exact field names below are Green API's own documented webhook shape; verify against a real
 * captured payload once a live instance is sending here, the same way whapi/client.ts's own
 * `image.link` assumption turned out to need correcting against a real payload.
 */
export interface GreenApiGroupSummary {
  /** Digits of the group's chat id, e.g. from "120363...@g.us" -- the SAME extraction
   *  convention extractIncomingMessages above already uses for groupId, so a discovered group's
   *  id matches exactly what a real webhook's source_chat_id would be. */
  groupId: string;
  name: string;
  /** The full, unmapped API entry -- kept for debugging against a real response and for any
   *  field a future need might want that isn't extracted above yet. */
  raw: unknown;
}

/**
 * Green API's documented GET getContacts endpoint lists every contact the connected instance
 * knows about, including groups (id ending "@g.us") alongside individuals ("@c.us") -- the
 * group-discovery mechanism for the Group Registry sync (see admin/groupSync.ts's
 * syncGroupsFromGreenApi), mirroring whapi/client.ts's listWhapiGroups for the Whapi-connected
 * number. DOCUMENTED BUT NOT EMPIRICALLY CONFIRMED (same caveat checkGreenApiHealth above
 * carries): this sandbox has no live Green API credentials to confirm the response shape
 * against. Parsed defensively -- tolerates a bare array or a {contacts:[...]} envelope, either
 * an `id` or `chatId` field, and skips (with a warning, never a throw) any entry with no
 * recognizable id or that isn't a group, so one unexpected row can't drop the whole discovery
 * run.
 *
 * Only ever covers the ONE Green API instance Fi holds instanceId/apiToken for (the "push"
 * number -- see config.ts's own comment on config.channels.greenApi). An additional
 * monitoring-only number (Fi holds no credentials for those at all, by design) can never be
 * actively discovered this way -- only passively, from an actual incoming webhook message
 * naming a groupId Fi doesn't already know.
 */
export async function listGreenApiGroups(): Promise<GreenApiGroupSummary[]> {
  if (!config.channels.greenApi.instanceId || !config.channels.greenApi.apiToken) return [];
  const res = await fetch(`${apiBase()}/getContacts/${config.channels.greenApi.apiToken}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(GREEN_API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Green API GET getContacts failed: ${res.status} ${text}`);
  }
  const body = (await res.json().catch(() => null)) as { contacts?: unknown[] } | unknown[] | null;
  const list: any[] = Array.isArray(body) ? body : Array.isArray((body as any)?.contacts) ? (body as any).contacts : [];
  const groups: GreenApiGroupSummary[] = [];
  for (const item of list) {
    const rawId = String(item?.id ?? item?.chatId ?? "").trim();
    if (!rawId.endsWith("@g.us")) continue; // an individual contact, not a group
    const digits = digitsOnly(rawId);
    if (!digits) {
      console.warn("[greenApi] GET getContacts returned a group entry with no recognizable id, skipping:", item);
      continue;
    }
    groups.push({ groupId: digits, name: String(item?.name ?? "").trim(), raw: item });
  }
  return groups;
}

export interface GreenApiJoinResult {
  groupId: string;
}

/**
 * Green API's documented POST joinGroupInviteLink -- the connected instance joins a WhatsApp
 * group directly from its invite link (https://chat.whatsapp.com/<code>), rather than needing
 * that group's own admin to separately add this number as a participant. This is the practical
 * fix for a monitoring-only number's groups (see listGreenApiGroups's own comment on the gap):
 * once the ONE Green API instance Fi actually holds credentials for joins a group itself, that
 * group shows up in this SAME instance's own getContacts on the very next discovery sync, and
 * its messages arrive over the webhook Fi already has configured -- no second/third instance's
 * credentials ever needed.
 *
 * Unlike every other function in this file, an unconfigured instance THROWS here rather than
 * silently skipping-and-warning: joining a group is a deliberate, one-off admin action (see
 * admin/view.ts's "Join via invite link"), not a routine background send where a silent no-op
 * is the safe default -- an admin who clicks this needs to know immediately if it did nothing.
 *
 * DOCUMENTED BUT NOT EMPIRICALLY CONFIRMED (same caveat every other Green API call in this file
 * carries): this sandbox has no live credentials to confirm the response shape against.
 */
export async function joinGroupByInviteLink(inviteLink: string): Promise<GreenApiJoinResult> {
  if (!config.channels.greenApi.instanceId || !config.channels.greenApi.apiToken) {
    throw new Error("GREEN_API_INSTANCE_ID/GREEN_API_API_TOKEN not set — cannot join a group.");
  }
  const body = await post("joinGroupInviteLink", { inviteLink });
  const groupId = digitsOnly(String(body?.groupId ?? ""));
  if (!groupId) throw new Error(`Green API joinGroupInviteLink returned no recognizable groupId: ${JSON.stringify(body)}`);
  return { groupId };
}

export interface GreenApiWebhook {
  typeWebhook?: string;
  idMessage?: string;
  senderData?: {
    chatId?: string;
    sender?: string;
    senderName?: string;
    senderContactName?: string;
  };
  messageData?: {
    typeMessage?: string;
    textMessageData?: { textMessage?: string };
    extendedTextMessageData?: { text?: string };
    fileMessageData?: { downloadUrl?: string; caption?: string; mimeType?: string; fileName?: string };
    locationMessageData?: { latitude?: number; longitude?: number; nameLocation?: string; address?: string };
  };
}

function textOf(messageData: GreenApiWebhook["messageData"]): string {
  return messageData?.textMessageData?.textMessage ?? messageData?.extendedTextMessageData?.text ?? messageData?.fileMessageData?.caption ?? "";
}

/**
 * Normalizes one Green API webhook delivery into the same shape whapi/client.ts's and
 * channels/whatsappCloud.ts's own extractIncomingMessages produce, so server.ts's shared
 * processing pipeline doesn't need to know which provider (or which of the 2-3 connected
 * numbers) a message actually arrived through. Unlike the Cloud API webhook, Green API posts
 * one message per HTTP delivery, not a batch -- so this returns 0 or 1 entries, still an array
 * for a uniform call site.
 *
 * A "reactionMessage" (emoji double-tap on an earlier message) is a bare gesture, not an attempt
 * to communicate anything -- same exclusion whapi/client.ts and whatsappCloud.ts both apply, for
 * the same reason (reacting to Fi's own reply must never produce a spurious "I didn't understand
 * that"). Every OTHER content-less type (document, audio, video, sticker, ...) still reaches the
 * flow so its own fallback can respond, same posture as the other two providers' catch-alls.
 */
export function extractIncomingMessages(body: GreenApiWebhook): NormalizedIncomingMessage[] {
  if (body.typeWebhook !== "incomingMessageReceived") return [];
  const type = body.messageData?.typeMessage;
  if (!type || type === "reactionMessage") return [];
  const chatId = body.senderData?.chatId ?? "";
  const isGroup = chatId.includes("@g.us");
  const hasImage = type === "imageMessage" && Boolean(body.messageData?.fileMessageData?.downloadUrl);
  const hasLocation = type === "locationMessage" && body.messageData?.locationMessageData?.latitude !== undefined && body.messageData?.locationMessageData?.longitude !== undefined;
  return [
    {
      id: body.idMessage ?? "",
      phone: digitsOnly(isGroup ? body.senderData?.sender ?? "" : chatId || body.senderData?.sender || ""),
      text: textOf(body.messageData),
      isGroup,
      groupId: isGroup ? digitsOnly(chatId) : undefined,
      senderName: body.senderData?.senderName || body.senderData?.senderContactName,
      imageUrl: hasImage ? body.messageData!.fileMessageData!.downloadUrl : undefined,
      location: hasLocation
        ? { latitude: body.messageData!.locationMessageData!.latitude!, longitude: body.messageData!.locationMessageData!.longitude! }
        : undefined,
    },
  ];
}
