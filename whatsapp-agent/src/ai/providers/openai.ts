import { config } from "../../config";
import { AiJsonRequest } from "../client";
import { parseJsonFromModelText } from "./shared";

interface OpenAiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string | null;
    param?: string | null;
  };
}

export interface OpenAiErrorDetail {
  type: string | null;
  code: string | null;
  param: string | null;
  message: string;
  requestId: string | null;
}

/**
 * Parses OpenAI's actual structured error shape ({"error":{message,type,code,param}}) plus the
 * x-request-id response header — never the raw, possibly-truncated body alone, and never the
 * API key. Falls back to the raw response text as `message` if the body isn't valid JSON (e.g.
 * an upstream proxy/gateway error page instead of OpenAI's own JSON).
 */
async function parseOpenAiError(res: Response): Promise<OpenAiErrorDetail> {
  const requestId = res.headers.get("x-request-id");
  const rawText = await res.text().catch(() => "");
  let parsed: OpenAiErrorBody | null = null;
  try {
    parsed = rawText ? (JSON.parse(rawText) as OpenAiErrorBody) : null;
  } catch {
    parsed = null;
  }
  return {
    type: parsed?.error?.type ?? null,
    code: parsed?.error?.code ?? null,
    param: parsed?.error?.param ?? null,
    message: parsed?.error?.message ?? (rawText || "<no response body>"),
    requestId,
  };
}

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
 * Note: some newer/reasoning-tier OpenAI models are Responses-API-only and may reject Chat
 * Completions' parameters (`max_tokens`, plain `messages`) outright with a 400 — see
 * runOpenAiDiagnosticCall below, which isolates exactly that question independently of this
 * function's own structured-output prompting.
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
      const detail = await parseOpenAiError(res);
      console.error("[ai/openai] request failed", { status: res.status, ...detail });
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

export interface OpenAiDiagnosticResult {
  ok: boolean;
  status?: number;
  outputText?: string;
  error?: OpenAiErrorDetail;
}

/**
 * Minimal, isolated call to OpenAI's Responses API (NOT Chat Completions) — verifies the
 * configured model + key work at all, independent of this app's own structured-output prompts.
 * Deliberately a separate raw fetch (no SDK/zod dependency added) rather than reusing
 * callOpenAiJson's endpoint: some reasoning-tier models are Responses-API-only, so a failure
 * here points squarely at the model name/key/API surface, not at anything the matching prompts
 * themselves do. Exposed via GET /admin/ai-diagnostic so this can be triggered on demand rather
 * than adding an extra OpenAI call (and cost) to every single deploy.
 */
export async function runOpenAiDiagnosticCall(): Promise<OpenAiDiagnosticResult> {
  if (!config.aiMatching.openaiApiKey || !config.aiMatching.openaiModel) {
    return {
      ok: false,
      error: { type: "unconfigured", code: null, param: null, message: "OPENAI_API_KEY or AI_MATCHING_OPENAI_MODEL is not set", requestId: null },
    };
  }
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.aiMatching.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.aiMatching.openaiModel,
        input: "Return exactly OK.",
        reasoning: { effort: "none" },
        max_output_tokens: 20,
      }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await parseOpenAiError(res) };
    }
    const body = (await res.json()) as { output_text?: string; output?: { content?: { text?: string }[] }[] };
    const outputText = body.output_text ?? body.output?.[0]?.content?.[0]?.text;
    return { ok: true, status: res.status, outputText };
  } catch (err) {
    return { ok: false, error: { type: "network_error", code: null, param: null, message: (err as Error).message, requestId: null } };
  }
}
