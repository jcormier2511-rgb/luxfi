const SKIP_WORDS = ["any", "none", "no preference", "n/a", "na", "skip", "whatever", "either"];

/** Treats "any"/"skip"/etc as "no preference" — returns undefined instead of storing the word. */
function skipToUndefined(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (!t || SKIP_WORDS.includes(t)) return undefined;
  return t;
}

function toNumber(raw: string): number | undefined {
  let s = raw.replace(/[$,]/g, "").trim().toLowerCase();
  let multiplier = 1;
  if (s.endsWith("k")) {
    multiplier = 1000;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * multiplier : undefined;
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

  const rangeMatch = normalized.match(/([\d.,]+k?)\s*(?:-|to|–)\s*([\d.,]+k?)/);
  if (rangeMatch) {
    const min = toNumber(rangeMatch[1]);
    const max = toNumber(rangeMatch[2]);
    if (min !== undefined || max !== undefined) return { min, max };
  }

  const maxOnlyMatch = normalized.match(/(?:under|up to|max|below|less than)\s*(?:usd|hkd|eur|gbp|aed|chf|cad|jpy|cny|rmb|hk\$|c\$|cn¥|[$€£¥])?\s*([\d.,]+k?)/);
  if (maxOnlyMatch) {
    const max = toNumber(maxOnlyMatch[1]);
    if (max !== undefined) return { max };
  }

  const minOnlyMatch = normalized.match(/(?:over|at least|min|above|more than)\s*(?:usd|hkd|eur|gbp|aed|chf|cad|jpy|cny|rmb|hk\$|c\$|cn¥|[$€£¥])?\s*([\d.,]+k?)/);
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
