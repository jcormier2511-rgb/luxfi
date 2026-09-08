/**
 * Canonical shape every channel's inbound message gets normalized into before reaching
 * server.ts's shared processing pipeline — structurally identical to whapi/client.ts's own
 * IncomingMessage (kept separate rather than imported from there so channels/ doesn't take on
 * a dependency on the WhatsApp-specific client module for a plain data shape).
 */
export interface NormalizedIncomingMessage {
  id: string;
  phone: string; // opaque identity: raw digits for WhatsApp, "telegram:<id>"/"sms:<number>" otherwise
  text: string;
  isGroup: boolean;
  groupId?: string;
  senderName?: string;
  imageUrl?: string;
  /** A shared location pin (WhatsApp/Telegram's native "share my location" message type),
   *  resolved to a place name by conversation/flow.ts before it's ever treated as a location
   *  answer — see geo/reverseGeocode.ts. */
  location?: { latitude: number; longitude: number };
}
