import { z } from "zod";
import { anthropic, LLM_MODEL } from "./client.js";

/**
 * Compares a listing's stated price against current secondary/grey-market
 * pricing via web search. A match is never blocked on this verdict — it's
 * surfaced as an advisory line, since "below_market" is a common scam
 * signal worth a dealer's attention even when the model isn't fully sure.
 */
const PriceCheckSchema = z.object({
  verdict: z.enum(["in_line", "below_market", "above_market", "unknown"]),
  marketMin: z.number().int().nullable(),
  marketMax: z.number().int().nullable(),
  notes: z.string(),
});

export interface PriceCheckResult {
  verdict: "in_line" | "below_market" | "above_market" | "unknown";
  marketMin: number | null;
  marketMax: number | null;
  notes: string;
}

export async function checkPrice(params: {
  brand: string | null;
  model: string | null;
  reference: string | null;
  category: string;
  condition: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
}): Promise<PriceCheckResult | null> {
  if (params.priceMin == null && params.priceMax == null) return null; // nothing to compare

  const itemDesc = [params.brand, params.model, params.reference].filter(Boolean).join(" ") || `a ${params.category}`;
  const stated = params.priceMin != null && params.priceMax != null && params.priceMin !== params.priceMax
    ? `${params.currency} ${params.priceMin.toLocaleString()}-${params.priceMax.toLocaleString()}`
    : `${params.currency} ${(params.priceMax ?? params.priceMin)!.toLocaleString()}`;

  const systemPrompt = `You are Fi's pricing analyst for LuxFi, a luxury dealer network (watches, handbags, jewelry). Research the current secondary/grey-market price range for the item below using web search, then compare it to the listed price.

Item: ${itemDesc}. Condition: ${params.condition ?? "not stated"}. Listed price: ${stated}.

After researching, respond with ONLY a single JSON object — no markdown fences, no extra text — in this exact shape:
{"verdict": "in_line" | "below_market" | "above_market" | "unknown", "marketMin": number|null, "marketMax": number|null, "notes": "one short sentence"}

Use "below_market" when the listed price is notably under the typical market range, even if you're not fully certain — that gap is a common scam signal worth flagging. Use "above_market" for notably over. Use "unknown" only if you couldn't find reliable pricing data. Keep notes under 20 words.`;

  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: LLM_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: "Research and compare the price as instructed." }],
    });

    const finalMessage = await runner;
    const text = finalMessage.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = PriceCheckSchema.safeParse(JSON.parse(jsonText));
    return parsed.success ? parsed.data : null;
  } catch (err) {
    // Best-effort enrichment — never let a failed check block listing intake.
    console.error("Price check failed:", err);
    return null;
  }
}
