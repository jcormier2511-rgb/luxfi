import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { anthropic, LLM_MODEL } from "./client.js";

/**
 * Fi's "understanding" of a group message: instead of a regex/keyword parser,
 * Claude reads the raw chat text and decides whether it's a WTB ("want to
 * buy") or FS/WTS ("for sale") post, extracting structured fields when it is.
 * Ordinary chatter, questions, and negotiation replies come back as
 * isListing: false, so they're never mistaken for a listing.
 */
const ListingExtractionSchema = z.object({
  isListing: z
    .boolean()
    .describe("True only if this message is a standalone WTB or FS/WTS post for a specific item, not chit-chat, a question, or a reply."),
  type: z.enum(["WTB", "FS"]).nullable(),
  category: z.enum(["watch", "handbag", "jewelry", "other"]).nullable(),
  brand: z.string().nullable().describe("Canonical brand name, e.g. 'Rolex', 'Audemars Piguet', 'Hermès'."),
  reference: z.string().nullable().describe("Model/reference number as written, e.g. '116500LN', '5711/1A'."),
  model: z.string().nullable().describe("Model name if given and distinct from the reference, e.g. 'Daytona'."),
  condition: z.string().nullable().describe("Condition/notes shorthand as written, e.g. 'NOS', 'full set', 'CH'."),
  priceMin: z.number().int().nullable().describe("Lower bound of the stated price, normalized to a plain integer (e.g. '$18k' -> 18000)."),
  priceMax: z.number().int().nullable().describe("Upper bound of the stated price; equal to priceMin for a single price."),
  currency: z.string().nullable().describe("ISO-ish currency code, default USD if a bare $ is used."),
  location: z.string().nullable().describe("City stated in the post, if any."),
});

const SYSTEM_PROMPT = `You are Fi, LuxFi's agent that silently monitors luxury dealer WhatsApp groups (watches, handbags, jewelry) for WTB ("want to buy") and FS/WTS ("for sale") posts.

Given one chat message, decide whether it is a standalone buy/sell listing and extract structured fields. Dealer shorthand is terse (e.g. "WTB Daytona 116500LN $18-20k CH"). Never invent a value that isn't stated — leave the field null instead. If the message is ambiguous, general conversation, a question, or a reply/negotiation rather than a fresh post, set isListing to false and leave every other field null.`;

export interface ExtractedListing {
  type: "WTB" | "FS";
  category: "watch" | "handbag" | "jewelry" | "other";
  brand: string | null;
  reference: string | null;
  model: string | null;
  condition: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  location: string | null;
}

export async function extractListing(rawText: string): Promise<ExtractedListing | null> {
  const text = rawText.trim();
  if (!text) return null;

  const response = await anthropic.messages.parse({
    model: LLM_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: text }],
    output_config: { format: zodOutputFormat(ListingExtractionSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed || !parsed.isListing || !parsed.type) return null;

  return {
    type: parsed.type,
    category: parsed.category ?? "watch",
    brand: parsed.brand,
    reference: parsed.reference,
    model: parsed.model,
    condition: parsed.condition,
    priceMin: parsed.priceMin,
    priceMax: parsed.priceMax,
    currency: parsed.currency ?? "USD",
    location: parsed.location,
  };
}
