import crypto from "crypto";
import { callAiJson } from "./client";
import { ListingEnrichment } from "./types";

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

const ENRICH_SYSTEM = `You extract structured watch-listing data from raw dealer text for a luxury watch marketplace.
Rules:
- A message may describe ONE watch or MANY (a bundle/price-list dump) — return one JSON object per distinct watch you can find, not one per message.
- referenceFamily is the base reference number without a dial/bracelet-code suffix (e.g. "116500LN" -> family "116500"); referenceRaw is the reference exactly as it best appears in the text, if any.
- "evidence" MUST be a verbatim substring copied EXACTLY from the input text that supports this specific watch's fields — never paraphrase it, never invent it, never combine text from two different watches.
- If you are not confident about a field, set it to null rather than guessing. confidence is 0-1 for the row as a whole.
- Respond with ONLY a JSON array of objects, no prose, no markdown fence. Each object has exactly these keys: brand, model, referenceRaw, referenceFamily, variant, year, condition, price, currency, location, confidence, evidence.`;

/**
 * Splits and enriches raw listing text into one or more structured watches. Every returned
 * row's `evidence` is verified as an actual (case-insensitive) substring of `rawText` — a row
 * whose evidence isn't literally present in the source is dropped rather than trusted, since
 * enrichment must never invent a watch that isn't really in the text. Returns [] (never throws)
 * when AI is unavailable/fails, so callers always have a safe "nothing extracted" fallback.
 */
export async function enrichListingText(rawText: string): Promise<ListingEnrichment[]> {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  const result = await callAiJson<ListingEnrichment[]>({
    system: ENRICH_SYSTEM,
    user: trimmed,
    maxTokens: 2048,
  });
  if (!Array.isArray(result)) return [];
  const haystack = trimmed.toLowerCase();
  return result.filter(
    (row) => row && typeof row.evidence === "string" && row.evidence.trim().length > 0 && haystack.includes(row.evidence.trim().toLowerCase())
  );
}
