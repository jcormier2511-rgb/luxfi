import { config } from "../config";
import { callAnthropicJson } from "./providers/anthropic";
import { callOpenAiJson } from "./providers/openai";

export interface AiJsonRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Provider-agnostic entry point every AI-matching module (enrichment/queryInterpreter/rerank)
 * calls — none of them know or care which backend actually answers. Routes to whichever
 * provider AI_MATCHING_PROVIDER selects (default "anthropic"); both providers share the exact
 * same contract (see providers/anthropic.ts, providers/openai.ts): never throws, and collapses
 * "unconfigured", network failure, a non-2xx response, or unparseable JSON all to the same
 * null, so every caller has one safe "AI unavailable right now" case to fall back on.
 */
export async function callAiJson<T>(req: AiJsonRequest): Promise<T | null> {
  if (config.aiMatching.provider === "openai") return callOpenAiJson<T>(req);
  return callAnthropicJson<T>(req);
}
