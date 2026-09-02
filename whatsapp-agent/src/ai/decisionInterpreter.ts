import { callAiJson } from "./client";

/** A free-form reply interpreted as an approve/pass decision against the currently shown matches. */
export interface InterpretedDecision {
  action: "approve" | "pass" | null;
  /** 1-based index of the match meant, or null if not identifiable (caller defaults to 1, same as the deterministic parser). */
  index: number | null;
}

const DECISION_SYSTEM = `The user was just shown a numbered list of potential watch matches and asked to reply "approve <number>" or "pass <number>" — but people often answer more naturally.
Rules:
- action is "approve" if they want to connect/proceed/take/accept one of the shown matches, "pass" if they want to skip/decline/reject one, or null if the message isn't actually a decision about the shown matches at all (a new search, a greeting, a question, small talk).
- index is the 1-based number of the match they mean, if identifiable (e.g. "the first one" -> 1, "number 2" -> 2, "yeah let's do that one" when only one was shown -> 1). Use null if no specific match is identifiable from the text alone.
- Never guess a decision from an ambiguous or unrelated message — when in doubt, return action: null.
- Respond with ONLY a JSON object, no prose, no markdown fence, with exactly these keys: action, index.`;

/**
 * Returns null (never throws) on any failure/disabled state — the caller (flow.ts) only ever
 * uses this to try a SECOND interpretation after the deterministic "approve <n>"/"pass <n>"
 * parser already found nothing; it never replaces that parser. Once an action/index comes back,
 * flow.ts hands it to the SAME handleDecision function the deterministic path uses — this
 * function only ever produces the same {action, index} shape a human typing "approve 2" would,
 * so every existing trial/entitlement/bounds-check rule still applies unchanged. AI is never
 * allowed to approve/reveal/charge anything on its own; it only maps words to a slot number.
 */
export async function interpretDecision(text: string, matchCount: number): Promise<InterpretedDecision | null> {
  const trimmed = text.trim();
  if (!trimmed || matchCount <= 0) return null;
  const result = await callAiJson<InterpretedDecision>({
    system: DECISION_SYSTEM,
    user: `${matchCount} match(es) were shown, numbered 1-${matchCount}.\nUser's reply: ${trimmed}`,
    maxTokens: 128,
  });
  if (!result || (result.action !== "approve" && result.action !== "pass" && result.action !== null)) return null;
  return result;
}
