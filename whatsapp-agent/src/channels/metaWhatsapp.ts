import crypto from "crypto";

export type MetaWhatsAppTextMessage = { id: string; from: string; text: string; phoneNumberId?: string };

export function verifyMetaSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const supplied = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

/** Extracts only inbound text messages; statuses and unknown payload shapes are ignored. */
export function extractMetaTextMessages(payload: unknown): MetaWhatsAppTextMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const result: MetaWhatsAppTextMessage[] = [];
  for (const entry of entries) {
    const changes = entry && typeof entry === "object" ? (entry as { changes?: unknown }).changes : undefined;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = change && typeof change === "object" ? (change as { value?: unknown }).value : undefined;
      if (!value || typeof value !== "object") continue;
      const typedValue = value as { metadata?: { phone_number_id?: unknown }; messages?: unknown };
      if (!Array.isArray(typedValue.messages)) continue;
      for (const message of typedValue.messages) {
        if (!message || typeof message !== "object") continue;
        const typed = message as { id?: unknown; from?: unknown; type?: unknown; text?: { body?: unknown } };
        if (typed.type !== "text" || typeof typed.id !== "string" || typeof typed.from !== "string" || typeof typed.text?.body !== "string") continue;
        result.push({ id: typed.id, from: typed.from, text: typed.text.body,
          phoneNumberId: typeof typedValue.metadata?.phone_number_id === "string" ? typedValue.metadata.phone_number_id : undefined });
      }
    }
  }
  return result;
}
