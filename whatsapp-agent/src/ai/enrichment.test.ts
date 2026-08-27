import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require("./client") as typeof import("./client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { enrichListingText, contentHash } = require("./enrichment") as typeof import("./enrichment");

function enrichmentRow(overrides: Partial<Awaited<ReturnType<typeof enrichListingText>>[number]> = {}) {
  return {
    brand: "Rolex",
    model: null,
    referenceRaw: "116500LN",
    referenceFamily: "116500",
    variant: null,
    year: null,
    condition: "Used",
    price: 28500,
    currency: "USD",
    location: null,
    confidence: 0.9,
    evidence: "116500LN",
    ...overrides,
  };
}

test("contentHash is stable for the same text and differs for different text", () => {
  assert.equal(contentHash("Rolex Daytona 116500LN"), contentHash("Rolex Daytona 116500LN"));
  assert.notEqual(contentHash("Rolex Daytona 116500LN"), contentHash("Rolex Daytona 116508-0013"));
});

test("enrichListingText returns [] for empty/blank text without calling AI at all", async (t) => {
  const spy = t.mock.method(client, "callAiJson", async () => {
    throw new Error("must never be called for empty input");
  });
  assert.deepEqual(await enrichListingText(""), []);
  assert.deepEqual(await enrichListingText("   "), []);
  assert.equal(spy.mock.callCount(), 0);
});

test("enrichListingText returns rows whose evidence is verified against the source text", async (t) => {
  t.mock.method(client, "callAiJson", async () => [enrichmentRow({ evidence: "116500LN" })]);
  const rows = await enrichListingText("Rolex Daytona 116500LN, box and papers");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].referenceFamily, "116500");
});

test("required regression: a row whose evidence is not actually present in the source text is dropped, not trusted", async (t) => {
  t.mock.method(client, "callAiJson", async () => [enrichmentRow({ evidence: "this text was never in the input" })]);
  const rows = await enrichListingText("Rolex Daytona 116500LN, box and papers");
  assert.deepEqual(rows, [], "an unverifiable/hallucinated row must never be trusted");
});

test("enrichListingText splits a multi-watch blast into one row per watch with real evidence", async (t) => {
  const text = "Ready in stock: 116500 black 2023 199k, 124300 green 2023 66k";
  t.mock.method(client, "callAiJson", async () => [
    enrichmentRow({ referenceFamily: "116500", evidence: "116500 black 2023 199k" }),
    enrichmentRow({ referenceFamily: "124300", evidence: "124300 green 2023 66k" }),
  ]);
  const rows = await enrichListingText(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.referenceFamily),
    ["116500", "124300"]
  );
});

test("enrichListingText returns [] when the AI call itself fails (never throws)", async (t) => {
  t.mock.method(client, "callAiJson", async () => null);
  const rows = await enrichListingText("Rolex Daytona 116500LN");
  assert.deepEqual(rows, []);
});
