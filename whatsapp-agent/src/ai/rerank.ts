import { callAiJson } from "./client";
import { InventoryListing } from "../types";
import { InterpretedQuery, RerankPick } from "./types";

const RERANK_SYSTEM = `You are choosing which of the given candidate watch listings genuinely satisfy a buyer/seller's request.
Rules:
- Only pick from the given candidates, by their exact "id" — never invent an id or describe a watch that isn't one of them.
- "evidence" for each pick MUST be a verbatim substring copied from THAT candidate's own text — never from another candidate, never invented.
- If a candidate's reference is explicitly a different watch than what's requested, do not pick it, even if the brand matches.
- If nothing genuinely qualifies, return an empty array — never pick a weak/unrelated candidate just to return something.
- Respond with ONLY a JSON array, no prose, no markdown fence. Each object has exactly these keys: id, explanation, evidence.`;

interface CandidateForAi {
  id: string;
  text: string;
}

function candidateText(listing: InventoryListing): string {
  return [listing.brand, listing.item, listing.ref, listing.condition, listing.price, listing.location, listing.description]
    .filter(Boolean)
    .join(" | ");
}

/**
 * Reranks a pre-safety-gated candidate pool (already active, correct side — see
 * matching/engine.ts's findMatchesHybrid, which filters before AND re-verifies after this
 * call). Returns null on any AI failure so callers fall back to deterministic ranking rather
 * than treating an AI outage as "no inventory". Every returned pick's evidence is verified as
 * a literal substring of THAT candidate's own text, and any pick whose id isn't in the given
 * candidate set is dropped — the model can narrow/explain the given pool, never expand or
 * replace it with something it made up.
 */
export async function rerankCandidates(query: InterpretedQuery, candidates: InventoryListing[]): Promise<RerankPick[] | null> {
  if (candidates.length === 0) return [];
  const byId = new Map(candidates.map((c) => [c.id, c] as const));
  const forAi: CandidateForAi[] = candidates.map((c) => ({ id: c.id, text: candidateText(c) }));

  const result = await callAiJson<RerankPick[]>({
    system: RERANK_SYSTEM,
    user: JSON.stringify({ query, candidates: forAi }),
    maxTokens: 1536,
  });
  if (!Array.isArray(result)) return null;

  return result.filter((pick) => {
    const candidate = byId.get(pick?.id);
    if (!candidate) return false; // not a real candidate — never trust an invented id
    if (typeof pick.evidence !== "string" || !pick.evidence.trim()) return false;
    return candidateText(candidate).toLowerCase().includes(pick.evidence.trim().toLowerCase());
  });
}
