import { config } from "../config";

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

async function post(path: string, body: unknown): Promise<any> {
  if (!config.whapi.token) {
    console.warn(`[whapi] WHAPI_TOKEN not set — skipping live call to ${path}. Payload:`, body);
    return { simulated: true };
  }
  const res = await fetch(`${config.whapi.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.whapi.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whapi ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export interface WhapiHealthResult {
  configured: boolean;
  reachable: boolean;
  // null (rather than false) when the response came back but didn't match the documented shape
  // below — an unrecognized-but-successful response must never be reported as "not connected."
  authorized: boolean | null;
  statusText: string | null;
  version: string | null;
  error: string | null;
}

/**
 * Whapi.Cloud's documented GET /health endpoint (https://whapi.readme.io/reference/checkhealth)
 * reports channel status — {health:{status:{code,text},version,...}}, with status.text "AUTH"
 * meaning fully connected — without sending anything, so it's safe to call from a read-only
 * admin panel. The exact shape is taken from Whapi's public docs; this sandbox's network egress
 * to whapi.readme.io is blocked, so it hasn't been confirmed against a live channel — same
 * "documented but not empirically confirmed" caveat this project already carries for other
 * Whapi/WatchFacts integrations (see README).
 */
export async function checkWhapiHealth(): Promise<WhapiHealthResult> {
  if (!config.whapi.token) {
    return { configured: false, reachable: false, authorized: null, statusText: null, version: null, error: null };
  }
  try {
    const res = await fetch(`${config.whapi.baseUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${config.whapi.token}` },
    });
    if (!res.ok) {
      return { configured: true, reachable: false, authorized: null, statusText: null, version: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { health?: { status?: { text?: string }; version?: string } } | null;
    const statusText = body?.health?.status?.text ?? null;
    return {
      configured: true,
      reachable: true,
      authorized: statusText ? statusText === "AUTH" : null,
      statusText,
      version: body?.health?.version ?? null,
      error: null,
    };
  } catch (err) {
    return { configured: true, reachable: false, authorized: null, statusText: null, version: null, error: (err as Error).message };
  }
}

export async function sendText(phone: string, message: string): Promise<void> {
  await post("/messages/text", {
    to: digitsOnly(phone),
    body: message,
  });
}

/** Business-initiated WhatsApp delivery must use an approved template outside the 24-hour service window. */
export async function sendTemplate(phone:string,name:string,language:string,parameters:string[],fallbackBody?:string):Promise<void>{
  await post("/messages/template",{to:digitsOnly(phone),template:{name,language:{code:language},components:[{type:"body",parameters:parameters.map(text=>({type:"text",text}))}]},body:fallbackBody});
}

export async function sendBannerImage(phone: string, imageUrl: string, caption?: string): Promise<void> {
  if (!imageUrl) return;
  await post("/messages/image", {
    to: digitsOnly(phone),
    media: imageUrl,
    caption: caption ?? "",
  });
}

/**
 * Shape of the payload Whapi POSTs to a configured channel webhook on the "messages" event.
 * A single call can batch several messages, so callers should iterate the array. Only the
 * fields the bot actually reads are typed here.
 *
 * NOTE: `from_name` on group messages is expected (WhatsApp/Whapi convention — group chat_ids
 * end in "@g.us", and `from` carries the individual sender's JID) but hasn't been confirmed
 * against a real group webhook payload yet. If group posts come through with no display name,
 * this field name is the first thing to check against an actual payload.
 */
export interface IncomingWebhook {
  event?: { type: string; event: string };
  messages?: {
    id: string;
    from_me: boolean;
    type: string;
    chat_id: string;
    from: string;
    from_name?: string;
    text?: { body: string };
    // NOTE: shape (image.link/image.caption) is Whapi's documented convention for media
    // messages but hasn't been confirmed against a real captured image-message payload yet —
    // same documented-limitation status as from_name above. If chat-originated postings never
    // pick up an imageUrl from a real dealer-group photo post, check this shape first.
    image?: { link?: string; caption?: string };
  }[];
}

export interface IncomingMessage {
  id: string;
  phone: string; // 1:1: the contact's number. Group: the individual sender's number.
  text: string;
  isGroup: boolean;
  groupId?: string; // digits of chat_id, only set when isGroup
  senderName?: string;
  // Set only for an image message that had a caption — an image with no caption has no text
  // to classify as FS/WTB (see postings/normalize.ts), so it's dropped entirely rather than
  // ingested with empty text.
  imageUrl?: string;
}

export function extractIncomingMessages(body: IncomingWebhook): IncomingMessage[] {
  return (body.messages ?? [])
    // An image message no longer needs a caption to be picked up — a seller answering Fi's own
    // private "please reply with 3-6 clear photos" request (see matching/photoRequests.ts) very
    // often sends bare, uncaptioned images. An uncaptioned image just carries empty `text`,
    // which is a safe no-op everywhere else that reads it (e.g. group-monitor's
    // classifyGroupPost("") already returns null and ingests nothing).
    //
    // Real reported bug: any OTHER message type (document, video, voice, sticker, ...) was
    // silently dropped here entirely — e.g. a document sent during an active step (sell-intake's
    // "attach a photo?") got zero reply at all, indistinguishable from the bot being stuck. It
    // carries no imageUrl (most document types genuinely aren't a usable photo), but same as an
    // uncaptioned image, it must still reach the conversation flow as a real, if content-less,
    // message so the active flow's own "I didn't understand that" fallback can respond.
    .filter(
      (m) =>
        !m.from_me &&
        (m.type === "text" ? Boolean(m.text?.body) : m.type === "image" ? Boolean(m.image?.link) : true)
    )
    .map((m) => {
      const isGroup = (m.chat_id ?? "").includes("@g.us");
      return {
        id: m.id,
        phone: digitsOnly(isGroup ? m.from : m.chat_id || m.from),
        text: m.type === "image" ? m.image?.caption ?? "" : m.type === "text" ? m.text!.body : "",
        isGroup,
        groupId: isGroup ? digitsOnly(m.chat_id) : undefined,
        senderName: m.from_name,
        imageUrl: m.type === "image" ? m.image?.link : undefined,
      };
    });
}
