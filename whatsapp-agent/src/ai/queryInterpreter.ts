import { callAiJson } from "./client";
import { InterpretedQuery } from "./types";

const INTERPRET_SYSTEM = `You convert a WhatsApp message into structured shopping intent for a luxury watch marketplace.
Rules:
- action is "buy" for someone wanting to acquire a watch (buy/find/search/available/looking for/ISO/need), or "sell" for someone offering one (sell/selling/FS/WTS).
- referenceFamily is the base reference number if one is named (e.g. "116500" from "116500LN" or "Daytona 116500"), without a dial/bracelet-code suffix. Leave it null if no reference is named.
- hardRequirements are constraints that MUST hold (an explicit reference, an explicit "under $X" price ceiling). preferences are soft/nice-to-have details (color, box/papers, condition) that should never exclude an otherwise-good match on their own.
- Respond with ONLY a JSON object, no prose, no markdown fence, with exactly these keys: action, brand, referenceFamily, maxPrice, minPrice, location, hardRequirements (string array), preferences (string array). Use null for any field you can't determine, and [] for no requirements/preferences.`;

/** Returns null (never throws) on any failure/disabled state — callers keep the existing deterministic parser as the real fallback. */
export async function interpretQuery(text: string): Promise<InterpretedQuery | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const result = await callAiJson<InterpretedQuery>({ system: INTERPRET_SYSTEM, user: trimmed, maxTokens: 512 });
  if (!result || (result.action !== "buy" && result.action !== "sell")) return null;
  return result;
}
