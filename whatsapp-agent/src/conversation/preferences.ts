import { normalizePriceShorthand } from "../postings/normalize";

const SKIP_WORDS = ["any", "none", "no preference", "n/a", "na", "skip", "whatever", "either"];

/** Treats "any"/"skip"/etc as "no preference" — returns undefined instead of storing the word. */
function skipToUndefined(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (!t || SKIP_WORDS.includes(t)) return undefined;
  return t;
}

/**
 * Delegates to postings/normalize.ts's normalizePriceShorthand — the SAME thousands-vs-decimal
 * disambiguation used for WatchFacts listing prices, so "105.000"/"105,000" both correctly mean
 * 105000 here too. This module used to have its own naive reimplementation (plain `Number()`
 * after stripping "$"/","), which silently read "105.000" as 105 — a real reported bug (see
 * ai/intentExtractor.ts's identical concern for natural-language price extraction).
 */
function toNumber(raw: string): number | undefined {
  const n = normalizePriceShorthand(raw);
  return n === null ? undefined : n;
}

export interface PriceRange {
  min?: number;
  max?: number;
}

/**
 * Accepts a loose range of free-text formats: "$5,000-$8,000", "5k-8k", "under 10000",
 * "up to $8k", "over 5000", "at least 5k", or a single number treated as an approximate
 * target (+/-15%). Returns undefined for "any"/"skip"/empty — meaning no constraint.
 */
export function parsePriceRange(text: string): PriceRange | undefined {
  const normalized = skipToUndefined(text);
  if (!normalized) return undefined;

  // `\$?\s*` before EACH number — a range is often written with the currency symbol repeated
  // on both ends ("$5,000-$8,000"), which the original single-leading-`$` version missed on
  // the second number entirely (falling through to the single-target approximation instead).
  const rangeMatch = normalized.match(/\$?\s*([\d.,]+k?)\s*(?:-|to|–)\s*\$?\s*([\d.,]+k?)/i);
  if (rangeMatch) {
    const min = toNumber(rangeMatch[1]);
    const max = toNumber(rangeMatch[2]);
    if (min !== undefined || max !== undefined) return { min, max };
  }

  const maxOnlyMatch = normalized.match(/(?:under|up to|max(?:imum)?|below|less than|budget(?:\s+of)?)\s*(?:usd|hkd|eur|gbp|aed|chf|cad|sgd|jpy|cny|rmb|hk\$|c\$|s\$|cn¥|[$€£¥])?\s*([\d.,]+k?)/);
  if (maxOnlyMatch) {
    const max = toNumber(maxOnlyMatch[1]);
    if (max !== undefined) return { max };
  }

  const minOnlyMatch = normalized.match(/(?:over|at least|min(?:imum)?|above|more than)\s*(?:usd|hkd|eur|gbp|aed|chf|cad|sgd|jpy|cny|rmb|hk\$|c\$|s\$|cn¥|[$€£¥])?\s*([\d.,]+k?)/);
  if (minOnlyMatch) {
    const min = toNumber(minOnlyMatch[1]);
    if (min !== undefined) return { min };
  }

  const singleMatch = normalized.match(/\$?\s*([\d.,]+k?)/);
  if (singleMatch) {
    const target = toNumber(singleMatch[1]);
    if (target !== undefined) return { min: Math.round(target * 0.85), max: Math.round(target * 1.15) };
  }

  return undefined;
}

export function parseFreeformPreference(text: string): string | undefined {
  return skipToUndefined(text);
}
