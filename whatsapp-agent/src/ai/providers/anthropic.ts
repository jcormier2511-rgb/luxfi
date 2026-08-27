import { config } from "../../config";
import { AiJsonRequest } from "../client";
import { parseJsonFromModelText } from "./shared";

/**
 * Anthropic Messages API via Node's built-in `fetch` (Node 20+) — no SDK dependency added for
 * this one call site. Must NEVER throw and must NEVER return a partially-trusted result:
 * missing API key, network failure, a non-2xx response, or unparseable JSON all collapse to
 * null — the caller (client.ts's dispatcher) treats null as "AI unavailable right now."
 */
export async function callAnthropicJson<T>(req: AiJsonRequest): Promise<T | null> {
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
    return parseJsonFromModelText<T>(text);
  } catch {
    return null;
  }
}
