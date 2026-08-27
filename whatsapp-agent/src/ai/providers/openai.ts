import { config } from "../../config";
import { AiJsonRequest } from "../client";
import { parseJsonFromModelText } from "./shared";

/**
 * OpenAI Chat Completions API via Node's built-in `fetch` — mirrors callAnthropicJson's
 * contract exactly: never throws, collapses missing key/model, network failure, a non-2xx
 * response, or unparseable JSON to null. Requires BOTH OPENAI_API_KEY and
 * AI_MATCHING_OPENAI_MODEL to be set explicitly — there's no hardcoded default model id here,
 * since guessing one that might be wrong or already deprecated for your account is worse than
 * staying inert until you name the exact model you want.
 *
 * Uses free-text JSON in the prompt (not OpenAI's strict `json_object` response format) so this
 * stays symmetric with the Anthropic provider: some callers here need a top-level JSON ARRAY
 * back (enrichment, rerank), and json_object mode requires a top-level object.
 *
 * Note: some newer OpenAI models expect `max_completion_tokens` instead of `max_tokens` — if
 * your configured model rejects this request for that reason, say so and this can be adjusted.
 */
export async function callOpenAiJson<T>(req: AiJsonRequest): Promise<T | null> {
  if (!config.aiMatching.openaiApiKey || !config.aiMatching.openaiModel) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.aiMatching.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.aiMatching.openaiModel,
        max_tokens: req.maxTokens ?? 1024,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[ai/openai] request failed (${res.status}):`, await res.text().catch(() => "<no body>"));
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) return null;
    return parseJsonFromModelText<T>(text);
  } catch (err) {
    console.error("[ai/openai] request threw:", err);
    return null;
  }
}
