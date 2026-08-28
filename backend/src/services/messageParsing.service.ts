/**
 * Regex-based heuristic FS/WTB extractor (spec section 7 allows AI/heuristics
 * to extract and normalize listing data, as long as it never controls
 * identity/trial/billing -- deterministic matching still owns that). It only
 * recognizes messages that look like an FS or WTB post; everything else
 * returns null and is left alone (not every message in a group is a posting).
 *
 * This is the fallback path behind aiExtraction.client.ts's AnthropicExtractor
 * -- used directly when ANTHROPIC_API_KEY isn't set, and as the safety net
 * when a live AI extraction call fails for any reason. Known limitations
 * (documented, not hidden): no brand/model/dial/condition extraction, a
 * fairly permissive reference-number pattern that can over/under-match on
 * unusual formats, and no handling of multi-line or multi-item posts.
 */
export interface ParsedPosting {
  postingType: 'FS' | 'WTB';
  brand?: string;
  model?: string;
  referenceNumber?: string;
  dial?: string;
  material?: string;
  year?: number;
  condition?: string;
  boxPapers?: string;
  askingPrice?: number;
  maxBid?: number;
  currency?: string;
  location?: string;
  country?: string;
}

const FS_PATTERN = /\b(fs|for sale|selling)\b/i;
const WTB_PATTERN = /\b(wtb|ntq|want(?:ed)? to buy|looking for|iso)\b/i;

// Loose reference-number shape: 4-6 digits, optional trailing letters, optional
// hyphen/slash suffix. Matches common luxury-watch reference formats
// (e.g. 116500LN, 5711/1A) without claiming brand-specific accuracy.
const REFERENCE_PATTERN = /\b\d{4,6}[A-Za-z]{0,4}(?:[/-]\d{1,3}[A-Za-z]{0,2})?\b/;

// A bare run of digits is ambiguous with a reference number (e.g. "116500LN"),
// so a price is only recognized when it carries an explicit signal: a leading
// "$", a trailing currency code, or a "20k" shorthand. No signal -> no price,
// rather than guessing and misreading a reference as a price.
const PRICE_WITH_DOLLAR = /\$\s?(\d[\d,]{1,7})/;
const PRICE_WITH_CURRENCY = /\b(\d[\d,]{1,7})\s?(usd|eur|gbp|chf)\b/i;
const PRICE_WITH_K_SHORTHAND = /\b(\d{1,3})\s?k\b/i;

function extractPrice(text: string): { amount: number; currency?: string } | null {
  const dollarMatch = text.match(PRICE_WITH_DOLLAR);
  if (dollarMatch) return { amount: Number(dollarMatch[1].replace(/,/g, '')), currency: 'USD' };

  const currencyMatch = text.match(PRICE_WITH_CURRENCY);
  if (currencyMatch) {
    return { amount: Number(currencyMatch[1].replace(/,/g, '')), currency: currencyMatch[2].toUpperCase() };
  }

  const kMatch = text.match(PRICE_WITH_K_SHORTHAND);
  if (kMatch) return { amount: Number(kMatch[1]) * 1000, currency: 'USD' };

  return null;
}

export function parseFreeTextPosting(rawText: string): ParsedPosting | null {
  const text = rawText.trim();
  if (!text) return null;

  const isFs = FS_PATTERN.test(text);
  const isWtb = WTB_PATTERN.test(text);
  if (isFs === isWtb) return null; // neither recognized, or ambiguously both

  const postingType: 'FS' | 'WTB' = isFs ? 'FS' : 'WTB';
  const refMatch = text.match(REFERENCE_PATTERN);
  const price = extractPrice(text);

  return {
    postingType,
    referenceNumber: refMatch ? refMatch[0].toUpperCase() : undefined,
    askingPrice: postingType === 'FS' ? price?.amount : undefined,
    maxBid: postingType === 'WTB' ? price?.amount : undefined,
    currency: price?.currency,
  };
}
