/**
 * Neither provider is asked to use strict schema/JSON-mode enforcement (OpenAI's json_object
 * mode requires a top-level object, but some callers here — enrichment, rerank — need a
 * top-level array back, so a single free-text-JSON convention is what keeps both providers
 * symmetric). Both system prompts instruct "respond with ONLY JSON, no prose, no markdown
 * fence" — this defensively strips a fence anyway, since models don't always comply, but never
 * attempts to "repair" otherwise-malformed JSON beyond that.
 */
export function parseJsonFromModelText<T>(text: string): T | null {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
