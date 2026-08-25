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

export async function sendText(phone: string, message: string): Promise<void> {
  await post("/messages/text", {
    to: digitsOnly(phone),
    body: message,
  });
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
 */
export interface IncomingWebhook {
  event?: { type: string; event: string };
  messages?: {
    id: string;
    from_me: boolean;
    type: string;
    chat_id: string;
    from: string;
    text?: { body: string };
  }[];
}

export interface IncomingMessage {
  id: string;
  phone: string;
  text: string;
}

export function extractIncomingMessages(body: IncomingWebhook): IncomingMessage[] {
  return (body.messages ?? [])
    .filter((m) => !m.from_me && m.type === "text" && m.text?.body)
    .map((m) => ({
      id: m.id,
      phone: digitsOnly(m.chat_id || m.from),
      text: m.text!.body,
    }));
}
