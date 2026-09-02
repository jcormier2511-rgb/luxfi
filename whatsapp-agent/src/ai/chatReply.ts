import { callAiJson } from "./client";

const CHAT_SYSTEM = `You are Fi, a WhatsApp concierge bot for a luxury watch marketplace. The user just sent a message that isn't a buy/sell request, a search, or a decision on a match already shown to them (greetings, thanks, small talk, or a question about how Fi works).
Rules:
- Reply naturally and briefly — one or two short sentences, warm but not gushing.
- If asked how Fi works: Fi finds and matches watch listings from a network of dealers and private sellers; say "buy: <watch>" or "selling: <watch>" to search.
- If told there are pending matches awaiting a decision, naturally mention that in passing (e.g. remind them they can reply "approve" or "pass", or a new search) — don't ignore it, but don't repeat it like a robotic instruction either.
- Never invent a specific watch listing, price, dealer, or promise ("I found a great Daytona for you") — that only ever comes from an actual search.
- Never mention that you are an AI model, or any internal system/technical detail (code, admin, providers, etc.).
- Respond with ONLY a JSON object, no prose, no markdown fence: {"reply": "..."}.`;

/**
 * Pure text generation, no state mutation whatsoever — this only ever supplies the string
 * flow.ts shows back to the user for genuine small talk (no item request, and already ruled out
 * as a decision if matches were pending). It cannot approve/search/change trial or entitlement
 * state; the caller's canned fallback stands in whenever this returns null (AI disabled/
 * unavailable), so every contact still gets a usable reply either way. `pendingMatchCount` is
 * passed through as context only — a good assistant doesn't reply to "hi" as if a decision
 * someone still owes isn't there, but it's still just words in the reply, nothing else.
 */
export async function generateGeneralChatReply(text: string, pendingMatchCount = 0): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const context =
    pendingMatchCount > 0
      ? `[Context: ${pendingMatchCount} match(es) shown earlier are still awaiting the user's approve/pass decision.]\n${trimmed}`
      : trimmed;
  const result = await callAiJson<{ reply: string }>({ system: CHAT_SYSTEM, user: context, maxTokens: 200 });
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) return null;
  return result.reply.trim();
}
