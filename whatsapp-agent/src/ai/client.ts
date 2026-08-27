import { config } from "../config";

export interface AiJsonRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Thin wrapper over the Anthropic Messages API using Node's built-in `fetch` (Node 20+) — no
 * SDK dependency added for this one call site. Every caller in this module treats a null
 * return as "AI unavailable right now" and falls back to its existing deterministic behavior,
 * so this function must NEVER throw and must NEVER return a partially-trusted result: missing
 * API key, network failure, a non-2xx response, or a response that isn't valid JSON all
 * collapse to the same null.
 */
export async function callAiJson<T>(req: AiJsonRequest): Promise<T | null> {
  if (!config.aiMatching.apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.aiMatching.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.aiMatching.model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text;
    if (!text) return null;
    // Defensively strip a markdown code fence the model might wrap the JSON in — never
    // attempts to "repair" otherwise-malformed JSON beyond that.
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
