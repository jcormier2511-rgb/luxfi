import { config } from "../config";

function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

// Real reported bug: none of this file's fetch() calls had a timeout, and every inbound message
// for a given phone is processed serially (conversation/flow.ts's withPhoneSerialized) -- a
// single WHAPI call that stalls (a dropped connection that never resets, not an error) had
// nothing to bound it, so Node's fetch would wait indefinitely and every subsequent message from
// that SAME phone queued up behind it, unanswered, for however long the underlying socket took
// to eventually give up (observed as tens-of-minutes gaps in production). A timeout turns a
// silent stall into a fast, logged failure the existing try/catch in server.ts already handles.
const WHAPI_TIMEOUT_MS = 10_000;

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
    signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS),
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
 * Whapi.Cloud's GET /health endpoint reports channel status without sending anything, so it's
 * safe to call from a read-only admin panel. Confirmed live against a real, authorized channel
 * (this sandbox's network egress to Whapi is otherwise blocked, so this is the one exception to
 * the "documented but not empirically confirmed" caveat this project's other Whapi/WatchFacts
 * integrations carry — see README): the real shape is flat, `{status:"OK",channel:"<id>",
 * code:200}` — NOT the nested `{health:{status:{code,text},version}}` shape the docs/older
 * code assumed, which is why the admin dashboard previously showed "UNKNOWN" for a channel that
 * was actually authorized and healthy. There is no version field in this response at all.
 */
export async function checkWhapiHealth(): Promise<WhapiHealthResult> {
  if (!config.whapi.token) {
    return { configured: false, reachable: false, authorized: null, statusText: null, version: null, error: null };
  }
  try {
    const res = await fetch(`${config.whapi.baseUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${config.whapi.token}` },
      signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { configured: true, reachable: false, authorized: null, statusText: null, version: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { status?: string; channel?: string; code?: number } | null;
    const statusText = body?.status ?? null;
    return {
      configured: true,
      reachable: true,
      authorized: statusText ? statusText === "OK" : null,
      statusText,
      version: null,
      error: null,
    };
  } catch (err) {
    return { configured: true, reachable: false, authorized: null, statusText: null, version: null, error: (err as Error).message };
  }
}

export interface WhapiGroupSummary {
  /** Digits of the group's chat id, e.g. from "1203630...@g.us" -- the SAME extraction
   *  convention extractIncomingMessages already uses for groupId, so a discovered group's id
   *  matches exactly what a real webhook's source_chat_id would be. */
  groupId: string;
  name: string;
  /** The full, unmapped API entry -- kept for debugging against a real response and for any
   *  field a future need might want that isn't extracted above yet. */
  raw: unknown;
}

/**
 * Whapi.Cloud's documented GET /groups endpoint lists every WhatsApp group the connected
 * channel/account can currently see — the primary group-discovery mechanism for the Group
 * Registry sync (see admin/groupSync.ts). Same "documented but not empirically confirmed"
 * caveat as checkWhapiHealth above: this sandbox's network egress to whapi.readme.io is
 * blocked, so the exact response shape hasn't been confirmed against a live channel. Parsed
 * defensively — tolerates a bare array or a {groups:[...]} envelope, and either an `id` or
 * `chat_id` / `name` or `subject` field — and skips (with a warning, never a throw) any entry
 * with no recognizable id, so one unexpected row can't drop the whole discovery run.
 */
export async function listWhapiGroups(): Promise<WhapiGroupSummary[]> {
  if (!config.whapi.token) return [];
  const res = await fetch(`${config.whapi.baseUrl}/groups`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${config.whapi.token}` },
    signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Whapi GET /groups failed: ${res.status} ${text}`);
  }
  const body = (await res.json().catch(() => null)) as { groups?: unknown[] } | unknown[] | null;
  const list: any[] = Array.isArray(body) ? body : Array.isArray((body as any)?.groups) ? (body as any).groups : [];
  const groups: WhapiGroupSummary[] = [];
  for (const item of list) {
    const rawId = String(item?.id ?? item?.chat_id ?? "").trim();
    if (!rawId) {
      console.warn("[whapi] GET /groups returned an entry with no recognizable id, skipping:", item);
      continue;
    }
    groups.push({ groupId: digitsOnly(rawId), name: String(item?.name ?? item?.subject ?? "").trim(), raw: item });
  }
  return groups;
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
    // NOTE: shape (location.latitude/longitude) follows the WhatsApp Business API's own
    // documented location-message convention, which Whapi.Cloud otherwise mirrors closely
    // (image/text above), but — same caveat as those — hasn't been confirmed against a real
    // captured location-message payload yet. If a shared location pin never resolves to a
    // place name, check this shape first.
    location?: { latitude?: number; longitude?: number };
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
  // Set only for a shared location pin — resolved to a place name by conversation/flow.ts (see
  // geo/reverseGeocode.ts), never treated as identity/listing content the way text/imageUrl are.
  location?: { latitude: number; longitude: number };
}

export function extractIncomingMessages(body: IncomingWebhook): IncomingMessage[] {
  // Diagnostic only: real reported bug (still under investigation) -- every genuine text message
  // from WhatsApp arrives alongside a SECOND webhook delivery, same phone, same instant, a
  // different id, with no text and no image -- which the existing document/sticker catch-all
  // (see below) lets through as a real, if content-less, message, producing a spurious "I kept
  // your request draft open." right after a correct reply. `type`/`from_me` aren't in
  // IncomingMessage's own shape below, so logging the RAW message here is the only way to see
  // what that companion actually is before deciding how (or whether) to exclude it.
  for (const m of body.messages ?? []) {
    console.log(
      `[whapi] raw id=${m.id} type=${m.type} from_me=${m.from_me} text=${JSON.stringify(m.text?.body ?? null)} hasImage=${Boolean(m.image?.link)}`
    );
    // Live-reported bug: a real image message consistently logs hasImage=false above -- WHAPI's
    // own webhook confirms type="image" but our code never finds a usable link at `image.link`,
    // so the message is filtered out below before it ever reaches the conversation flow (the
    // photo is silently dropped). The assumed shape (image.link/image.caption) was "documented
    // but never confirmed against a real payload" per the type comment on IncomingWebhook above
    // -- this dumps the COMPLETE raw message for exactly the case that assumption is failing, so
    // the real field name/shape can be read directly out of these logs instead of guessed at.
    if (m.type === "image" && !m.image?.link) {
      console.log(`[whapi] raw image message with no usable link, full payload: ${JSON.stringify(m)}`);
    }
  }
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
    //
    // A "reaction" (double-tapping/emoji-reacting to any earlier message — a bare gesture, not
    // an attempt to communicate anything) is deliberately excluded from that same catch-all,
    // unlike a document/sticker/voice-note. Real reported bug: reacting to Fi's own reply (even
    // by accident — double-tap-to-react is a very easy gesture to trigger) produced a spurious
    // "I'm not sure I understood that" immediately after a perfectly good answer, since the
    // catch-all above was treating the reaction event itself as a real, if empty, message.
    .filter(
      (m) =>
        !m.from_me &&
        m.type !== "reaction" &&
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
        location:
          m.type === "location" && m.location?.latitude !== undefined && m.location?.longitude !== undefined
            ? { latitude: m.location.latitude, longitude: m.location.longitude }
            : undefined,
      };
    });
}
