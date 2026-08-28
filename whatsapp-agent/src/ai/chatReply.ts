import { callAiJson } from "./client";

const CHAT_SYSTEM = `You are Fi, a WhatsApp concierge bot for a luxury watch marketplace. The user just sent a message that isn't a buy/sell request, a search, or a decision on a match already shown to them (greetings, thanks, small talk, or a question about how Fi works).
Rules:
- Reply naturally and briefly — one or two short sentences, warm but not gushing.
- If asked how Fi works: Fi finds and matches watch listings from a network of dealers and private sellers; say "buy: <watch>" or "selling: <watch>" to search.
- Never invent a specific watch listing, price, dealer, or promise ("I found a great Daytona for you") — that only ever comes from an actual search.
- Never mention that you are an AI model, or any internal system/technical detail (code, admin, providers, etc.).
- Respond with ONLY a JSON object, no prose, no markdown fence: {"reply": "..."}.`;

/**
 * Pure text generation, no state mutation whatsoever — this only ever supplies the string
 * flow.ts shows back to the user for genuine small talk (no pending decision, no item request,
 * nothing else matched). It cannot approve/search/change trial or entitlement state; the
 * caller's canned fallback ('Try "buy: ..."') stands in whenever this returns null (AI
 * disabled/unavailable), so every contact still gets a usable reply either way.
 */
export async function generateGeneralChatReply(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const result = await callAiJson<{ reply: string }>({ system: CHAT_SYSTEM, user: trimmed, maxTokens: 200 });
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) return null;
  return result.reply.trim();
}
