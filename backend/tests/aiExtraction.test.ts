import { AnthropicExtractor, HeuristicExtractor } from '../src/adapters/aiExtraction.client';

function mockFetchOnce(response: { ok: boolean; status?: number; json?: unknown; text?: string }): typeof fetch {
  return (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.json,
      text: async () => response.text ?? '',
    }) as Response) as typeof fetch;
}

describe('HeuristicExtractor', () => {
  test('delegates to the regex parser', async () => {
    const extractor = new HeuristicExtractor();
    const result = await extractor.extract('FS Rolex Daytona 116500LN $18500');
    expect(result?.postingType).toBe('FS');
    expect(result?.referenceNumber).toBe('116500LN');
  });
});

describe('AnthropicExtractor', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('maps a successful tool_use response to a ParsedPosting', async () => {
    global.fetch = mockFetchOnce({
      ok: true,
      json: {
        content: [
          {
            type: 'tool_use',
            input: {
              isListing: true,
              postingType: 'WTB',
              brand: 'Rolex',
              model: 'Daytona',
              referenceNumber: '116500LN',
              maxBid: 22000,
              currency: 'USD',
              condition: 'excellent',
            },
          },
        ],
      },
    });

    const extractor = new AnthropicExtractor('fake-key');
    const result = await extractor.extract('Looking for a Daytona 116500LN, excellent condition, up to 22k');
    expect(result).toEqual({
      postingType: 'WTB',
      brand: 'Rolex',
      model: 'Daytona',
      referenceNumber: '116500LN',
      dial: undefined,
      material: undefined,
      year: undefined,
      condition: 'excellent',
      boxPapers: undefined,
      askingPrice: undefined,
      maxBid: 22000,
      currency: 'USD',
      location: undefined,
      country: undefined,
    });
  });

  test('returns null when the model says the message is not a listing', async () => {
    global.fetch = mockFetchOnce({ ok: true, json: { content: [{ type: 'tool_use', input: { isListing: false } }] } });
    const extractor = new AnthropicExtractor('fake-key');
    expect(await extractor.extract('anyone going to the watch fair?')).toBeNull();
  });

  test('falls back to the heuristic parser on an API error', async () => {
    global.fetch = mockFetchOnce({ ok: false, status: 500, text: 'boom' });
    const extractor = new AnthropicExtractor('fake-key');
    const result = await extractor.extract('FS Rolex Daytona 116500LN $18500');
    expect(result?.postingType).toBe('FS');
    expect(result?.referenceNumber).toBe('116500LN');
  });

  test('falls back to the heuristic parser on a malformed response', async () => {
    global.fetch = mockFetchOnce({ ok: true, json: { content: [] } });
    const extractor = new AnthropicExtractor('fake-key');
    const result = await extractor.extract('WTB Daytona 116500LN budget 20k');
    expect(result?.postingType).toBe('WTB');
  });

  test('falls back to the heuristic parser on a network exception', async () => {
    global.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const extractor = new AnthropicExtractor('fake-key');
    const result = await extractor.extract('FS Rolex Daytona 116500LN $18500');
    expect(result?.postingType).toBe('FS');
  });
});
