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

/** One of the user's own pending "Match ID#" cards (postings/notify.ts's
 *  formatMatchMessage) -- named by its counterpart's identity rather than a position, since each
 *  card is its own message (not a numbered list) and carries its own real match id already. */
export interface PostingsDecisionOption {
  matchId: number;
  counterpartName: string;
  brand: string;
  model: string;
  reference: string;
}

/** A free-form reply interpreted as an approve/pass decision against the user's own pending
 *  postings-based matches (see PostingsDecisionOption above) -- the "approve <id>"/"pass <id>"
 *  counterpart to InterpretedDecision above, for the v4/direct-posting match system rather than
 *  the v3 in-session numbered list. */
export interface InterpretedPostingsDecision {
  action: "approve" | "pass" | null;
  /** The specific matchId meant, if identifiable (e.g. by counterpart name/brand/model) -- must
   *  always be one of the ids actually offered in `options`; null if not identifiable (caller
   *  defaults to the most recently presented pending match, same convention as a bare
   *  "approve"/"pass" with no number). */
  matchId: number | null;
}

const POSTINGS_DECISION_SYSTEM = `The user has one or more pending "Match ID#" cards from Fi, each offering to connect them with a specific counterpart and asking them to reply "approve <id>" or "pass <id>" -- but people often answer more naturally instead ("yes, connect me with the seller", "let's do it", "not interested", "connect me with ABC Watches").
Rules:
- action is "approve" if they want to connect/proceed/accept one of the listed matches, "pass" if they want to skip/decline one, or null if the message isn't actually a decision about one of the listed matches at all (a new search, a greeting, a question, small talk).
- matchId is the id of the SPECIFIC match listed below that they mean, if identifiable (e.g. by counterpart name, brand, or model named in their reply). Use null if no specific match is identifiable from the text alone (e.g. a bare "yes"/"pass" with only one match listed, or nothing to distinguish which one among several).
- Never return a matchId that is not one of the ids listed below.
- Never guess a decision from an ambiguous or unrelated message -- when in doubt, return action: null.
- Respond with ONLY a JSON object, no prose, no markdown fence, with exactly these keys: action, matchId.`;

/**
 * Returns null (never throws) on any failure/disabled state or an id it invents that wasn't
 * actually offered — the caller (server.ts) only ever uses this AFTER the deterministic
 * "approve <id>"/"pass <id>" parser already found nothing, and only ever hands the result to the
 * SAME approveMatch/passMatch functions the deterministic path uses, restricted to matches this
 * exact recipient was actually shown (see getPendingMatchesForRecipient). AI is never allowed to
 * approve/reveal/charge anything on its own; it only maps words to one of the offered ids.
 */
export async function interpretPostingsDecision(
  text: string,
  options: PostingsDecisionOption[]
): Promise<InterpretedPostingsDecision | null> {
  const trimmed = text.trim();
  if (!trimmed || options.length === 0) return null;
  const listed = options
    .map((o) => `- id ${o.matchId}: ${[o.counterpartName, o.brand, o.model, o.reference].filter(Boolean).join(" / ") || "unnamed"}`)
    .join("\n");
  const result = await callAiJson<InterpretedPostingsDecision>({
    system: POSTINGS_DECISION_SYSTEM,
    user: `Pending matches:\n${listed}\n\nUser's reply: ${trimmed}`,
    maxTokens: 128,
  });
  if (!result || (result.action !== "approve" && result.action !== "pass" && result.action !== null)) return null;
  if (result.matchId !== null && !options.some((o) => o.matchId === result.matchId)) return null;
  return result;
}
