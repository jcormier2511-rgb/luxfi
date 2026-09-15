import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic, LLM_MODEL } from "./client.js";

/**
 * Lightweight visual triage on a photo posted alongside a listing — not a
 * certified authentication. Leans toward "inconclusive" whenever the photo
 * doesn't show enough to judge, so it never produces a false accusation.
 * A match is never blocked on this verdict; it's surfaced as an advisory
 * line for the dealer to weigh.
 */
const AuthenticityCheckSchema = z.object({
  verdict: z.enum(["likely_authentic", "possible_concern", "inconclusive"]),
  notes: z
    .string()
    .describe("One short sentence for a dealer: what you observed, or why the photo doesn't give enough to judge."),
});

export interface AuthenticityCheckResult {
  verdict: "likely_authentic" | "possible_concern" | "inconclusive";
  notes: string;
}

const SYSTEM_PROMPT = `You are Fi's authenticity reviewer for LuxFi, a luxury dealer network (watches, handbags, jewelry). You're shown a photo posted alongside a listing. Look for visual signs that support or cast doubt on authenticity for the stated item — proportions, engraving/font quality, hardware and stitching quality, materials, or signs the image is a stock/catalog photo rather than one the seller actually took.

This is a lightweight triage signal for dealers, not a certified authentication. Default to "inconclusive" when the photo is unclear, low-resolution, cropped, or doesn't show enough detail to judge — never guess toward "possible_concern" without a specific, describable visual reason.`;

export async function checkAuthenticity(params: {
  imageUrl: string;
  brand: string | null;
  model: string | null;
  reference: string | null;
  category: string;
}): Promise<AuthenticityCheckResult | null> {
  const itemDesc = [params.brand, params.model, params.reference].filter(Boolean).join(" ") || `a ${params.category} listing`;

  try {
    const response = await anthropic.messages.parse({
      model: LLM_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: params.imageUrl } },
            { type: "text", text: `Item claimed: ${itemDesc}.` },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(AuthenticityCheckSchema) },
    });
    return response.parsed_output ?? null;
  } catch (err) {
    // Best-effort enrichment — never let a failed check block listing intake.
    console.error("Authenticity check failed:", err);
    return null;
  }
}
