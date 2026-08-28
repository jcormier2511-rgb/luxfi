import { ParsedPosting, parseFreeTextPosting } from '../services/messageParsing.service';

const EXTRACTION_MODEL = process.env.ANTHROPIC_EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001';

/**
 * Free-text -> structured-posting extraction. Spec section 7: "AI may
 * extract and normalize listing data ... but AI must not control database
 * identity, trial usage, approval state, or billing." This interface only
 * ever produces normalized attributes that feed the deterministic matching
 * engine (matching.service.ts) -- it has no path to touch identity, trial,
 * approvals, or the ledger.
 */
export interface MessageExtractor {
  extract(text: string): Promise<ParsedPosting | null>;
}

/** Wraps the regex-based heuristic parser (messageParsing.service.ts) as an extractor. */
export class HeuristicExtractor implements MessageExtractor {
  async extract(text: string): Promise<ParsedPosting | null> {
    return parseFreeTextPosting(text);
  }
}

const EXTRACTION_TOOL = {
  name: 'extract_posting',
  description:
    'Extract a normalized FS (for sale) or WTB (want to buy) luxury-goods listing from a chat message. ' +
    'If the message is not an FS/WTB listing (e.g. small talk, a question, spam), set isListing to false.',
  input_schema: {
    type: 'object' as const,
    properties: {
      isListing: { type: 'boolean' as const },
      postingType: { type: 'string' as const, enum: ['FS', 'WTB'] },
      brand: { type: 'string' as const },
      model: { type: 'string' as const },
      referenceNumber: { type: 'string' as const },
      dial: { type: 'string' as const },
      material: { type: 'string' as const },
      year: { type: 'number' as const },
      condition: { type: 'string' as const },
      boxPapers: { type: 'string' as const },
      askingPrice: { type: 'number' as const, description: 'FS asking price, only if explicitly stated' },
      maxBid: { type: 'number' as const, description: 'WTB maximum budget, only if explicitly stated' },
      currency: { type: 'string' as const, description: 'ISO currency code, e.g. USD' },
      location: { type: 'string' as const },
      country: { type: 'string' as const },
    },
    required: ['isListing'],
  },
};

interface AnthropicToolUseBlock {
  type: 'tool_use';
  input: Record<string, unknown>;
}

/**
 * Real extractor backed by the Anthropic Messages API. Falls back to the
 * heuristic parser on any failure (missing key, network error, unexpected
 * response shape) -- per spec 7, "a failed AI enrichment ... must not
 * destroy or block an otherwise valid structured match."
 */
export class AnthropicExtractor implements MessageExtractor {
  private readonly fallback = new HeuristicExtractor();

  constructor(private readonly apiKey: string) {}

  async extract(text: string): Promise<ParsedPosting | null> {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: EXTRACTION_MODEL,
          max_tokens: 512,
          tools: [EXTRACTION_TOOL],
          tool_choice: { type: 'tool', name: 'extract_posting' },
          messages: [{ role: 'user', content: text }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as { content?: AnthropicToolUseBlock[] };
      const toolUse = body.content?.find((b) => b.type === 'tool_use');
      if (!toolUse) throw new Error('no tool_use block in Anthropic response');

      const input = toolUse.input;
      if (!input.isListing) return null;
      if (input.postingType !== 'FS' && input.postingType !== 'WTB') {
        throw new Error(`unexpected postingType: ${input.postingType}`);
      }

      return {
        postingType: input.postingType,
        brand: input.brand as string | undefined,
        model: input.model as string | undefined,
        referenceNumber: input.referenceNumber as string | undefined,
        dial: input.dial as string | undefined,
        material: input.material as string | undefined,
        year: input.year as number | undefined,
        condition: input.condition as string | undefined,
        boxPapers: input.boxPapers as string | undefined,
        askingPrice: input.askingPrice as number | undefined,
        maxBid: input.maxBid as number | undefined,
        currency: input.currency as string | undefined,
        location: input.location as string | undefined,
        country: input.country as string | undefined,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-extraction] falling back to heuristic parser: ${(err as Error).message}`);
      return this.fallback.extract(text);
    }
  }
}

let extractor: MessageExtractor | undefined;

export function getMessageExtractor(): MessageExtractor {
  if (!extractor) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    extractor = apiKey ? new AnthropicExtractor(apiKey) : new HeuristicExtractor();
  }
  return extractor;
}

export function setMessageExtractor(custom: MessageExtractor): void {
  extractor = custom;
}
