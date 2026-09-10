import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic client so this test exercises only our adapter logic
// (mapping parsed_output -> ExtractedListing) without hitting the real API.
const parseMock = vi.fn();
vi.mock("../llm/client.js", () => ({
  anthropic: { messages: { parse: (...args: unknown[]) => parseMock(...args) } },
  LLM_MODEL: "claude-opus-5",
}));

const { extractListing } = await import("../llm/listingExtractor.js");

describe("extractListing", () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it("maps a listing response to ExtractedListing", async () => {
    parseMock.mockResolvedValueOnce({
      parsed_output: {
        isListing: true,
        type: "WTB",
        category: "watch",
        brand: "Rolex",
        reference: "116500LN",
        model: "Daytona",
        condition: null,
        priceMin: 18000,
        priceMax: 20000,
        currency: "USD",
        location: null,
      },
    });

    const result = await extractListing("WTB Rolex Daytona 116500LN $18k-20k");
    expect(result).toEqual({
      type: "WTB",
      category: "watch",
      brand: "Rolex",
      reference: "116500LN",
      model: "Daytona",
      condition: null,
      priceMin: 18000,
      priceMax: 20000,
      currency: "USD",
      location: null,
    });
  });

  it("returns null when the model says it isn't a listing", async () => {
    parseMock.mockResolvedValueOnce({
      parsed_output: { isListing: false, type: null, category: null, brand: null, reference: null, model: null, condition: null, priceMin: null, priceMax: null, currency: null, location: null },
    });

    const result = await extractListing("anyone around this weekend?");
    expect(result).toBeNull();
  });

  it("returns null for empty input without calling the API", async () => {
    const result = await extractListing("   ");
    expect(result).toBeNull();
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("defaults category to watch and currency to USD when the model omits them", async () => {
    parseMock.mockResolvedValueOnce({
      parsed_output: { isListing: true, type: "FS", category: null, brand: "Omega", reference: null, model: null, condition: null, priceMin: 4500, priceMax: 4500, currency: null, location: null },
    });

    const result = await extractListing("FS Omega Speedmaster $4,500");
    expect(result?.category).toBe("watch");
    expect(result?.currency).toBe("USD");
  });
});
