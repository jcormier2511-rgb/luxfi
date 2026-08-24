import { describe, expect, it } from "vitest";
import { parseListing } from "../parsing/listingParser.js";

describe("parseListing", () => {
  it("parses a WTB post with a range price", () => {
    const result = parseListing("WTB Rolex Daytona 116500LN $18k-20k CH");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("WTB");
    expect(result?.brand).toBe("Rolex");
    expect(result?.reference).toBe("116500LN");
    expect(result?.priceMin).toBe(18000);
    expect(result?.priceMax).toBe(20000);
    expect(result?.condition).toContain("ch");
  });

  it("parses an FS post with a single price", () => {
    const result = parseListing("FS Rolex Daytona 116500LN $18,500 CH");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("FS");
    expect(result?.brand).toBe("Rolex");
    expect(result?.reference).toBe("116500LN");
    expect(result?.priceMin).toBe(18500);
    expect(result?.priceMax).toBe(18500);
  });

  it("recognizes WTS and 'for sale' as FS, and ISO/'looking for' as WTB", () => {
    expect(parseListing("WTS Omega Speedmaster $4,500")?.type).toBe("FS");
    expect(parseListing("Patek 5711/1A for sale, $140k, Geneva")?.type).toBe("FS");
    expect(parseListing("ISO Cartier Tank Louis, any condition")?.type).toBe("WTB");
    expect(parseListing("Looking for AP Royal Oak 15400ST")?.type).toBe("WTB");
  });

  it("extracts location hints", () => {
    const result = parseListing("FS Omega Speedmaster $4,500 Miami");
    expect(result?.location).toBe("Miami");
  });

  it("returns null for plain chatter", () => {
    expect(parseListing("anyone around this weekend?")).toBeNull();
    expect(parseListing("")).toBeNull();
  });

  it("returns null when both WTB and FS markers are present (ambiguous)", () => {
    expect(parseListing("WTB or FS Rolex, let me know what you have")).toBeNull();
  });

  it("handles brand aliases", () => {
    expect(parseListing("WTB AP Royal Oak 15400ST $25,000")?.brand).toBe("Audemars Piguet");
    expect(parseListing("FS Patek 5711/1A $140,000")?.brand).toBe("Patek Philippe");
  });
});
