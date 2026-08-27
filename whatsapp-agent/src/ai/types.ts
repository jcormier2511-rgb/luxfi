/** One structured watch extracted from raw listing/dealer text (see enrichment.ts). */
export interface ListingEnrichment {
  brand: string | null;
  model: string | null;
  referenceRaw: string | null;
  /** Base reference without a dial/bracelet-code suffix, e.g. "116500" from "116500LN". */
  referenceFamily: string | null;
  variant: string | null;
  year: number | null;
  condition: string | null;
  price: number | null;
  currency: string | null;
  location: string | null;
  /** 0-1 — how confident the model is in this row as a whole. */
  confidence: number;
  /** Verbatim substring of the source text that supports this row — never paraphrased. */
  evidence: string;
}

/** A WhatsApp message converted into structured shopping intent (see queryInterpreter.ts). */
export interface InterpretedQuery {
  action: "buy" | "sell";
  brand: string | null;
  referenceFamily: string | null;
  maxPrice: number | null;
  minPrice: number | null;
  location: string | null;
  hardRequirements: string[];
  preferences: string[];
}

/** One AI-selected candidate out of a pool it was given (see rerank.ts) — never a new id. */
export interface RerankPick {
  id: string;
  explanation: string;
  evidence: string;
}
