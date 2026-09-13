import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR — same reasoning as flow.entitlement.test.ts.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-matching-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE = "19990001111,19990004444,19990005555,19990002222";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "",
    ref: "",
    condition: "",
    price: "1000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: "",
    ...overrides,
  };
}

/** Drives the AI-matching-test-phone ephemeral search path -- the replacement for the old
 *  "buy: X" + a few "any" replies shortcut, which no longer reaches a v3 search at all (see
 *  conversation/flow.ts: `buy:`/`sell:` now creates a monitored posting like any other
 *  conversational request). The mocked intent supplies structured price/location/dial/condition
 *  preferences directly (skipping the follow-up interview), but `searchText` is still passed
 *  through unchanged as the real search query -- so the underlying reference-vs-price regex
 *  logic in matching/engine.ts (untouched by this routing change) is still genuinely exercised. */
async function freshSearch(t: TestContext, phone: string, query: string): Promise<string[]> {
  return freshSearchWithPreferences(t, phone, query, {});
}

async function freshSearchWithPreferences(
  t: TestContext,
  phone: string,
  query: string,
  overrides: { priceMax?: number; location?: string; dial?: string; condition?: string }
): Promise<string[]> {
  // Scoped to the real query text -- an unconditional mock would make the "hi" warm-up message
  // ALSO look like a confident buy intent (with this same hardcoded searchText), running a
  // second, duplicate search whose card gets collected alongside the real one.
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    text === query
      ? {
          intent: {
            intent: "buy" as const,
            brand: "Rolex",
            model: null,
            reference: null,
            dial: overrides.dial ?? "any",
            condition: overrides.condition ?? "any",
            year: null,
            boxPapers: null,
            priceMin: null,
            priceMax: overrides.priceMax ?? 500000,
            currency: "USD",
            location: overrides.location ?? "Global",
            searchText: query,
            confidence: 0.9,
          },
          priceUnreliable: false,
        }
      : null
  );
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, query));
  return collected;
}

test("required regression: no exact reference available → no results, Fi starts monitoring instead of showing a wrong watch", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona bundle lot" })],
    new Date().toISOString()
  );

  const messages = await freshSearch(t, "19990001111", "Rolex Daytona 116500LN");
  assert.ok(!messages.some((m) => /Potential Match/.test(m)), "must never show a card for a different reference");
  assert.ok(
    messages.some((m) => /No live matches yet/i.test(m) && /keep watching/i.test(m)),
    "must tell the user Fi will keep monitoring instead of going silent or showing something wrong"
  );
});

test("required regression: WTB Rolex Daytona 116500 black dial pre-owned USA max $25,000 excludes an over-budget listing; every surfaced card includes its description and only a working listing URL", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      fsRow("in-budget", {
        brand: "Rolex",
        ref: "116500LN",
        price: "24500",
        condition: "Pre-owned",
        location: "USA",
        description: "Rolex Daytona 116500LN black dial, pre-owned, box and papers, based in USA",
        detailUrl: "https://watchfacts.com/flash-sales/in-budget",
      }),
      fsRow("over-budget", {
        brand: "Rolex",
        ref: "116500LN",
        price: "26200",
        condition: "Pre-owned",
        location: "USA",
        description: "Rolex Daytona 116500LN black dial, mint condition, USA",
        detailUrl: "https://watchfacts.com/flash-sales/over-budget",
      }),
    ],
    new Date().toISOString()
  );

  // The in-budget listing's URL is live; the over-budget one is excluded by price before URL
  // validation would even matter, so its URL is deliberately left "broken" here too.
  const urlValidator = require("../watchfacts/urlValidator") as typeof import("../watchfacts/urlValidator");
  t.mock.method(urlValidator, "getValidatedListingUrl", async (url?: string) =>
    url === "https://watchfacts.com/flash-sales/in-budget" ? url : undefined
  );

  const messages = await freshSearchWithPreferences(t, "19990004444", "Rolex Daytona 116500 black dial pre-owned", {
    priceMax: 25000,
    location: "USA",
    dial: "black",
    condition: "pre-owned",
  });

  assert.ok(!messages.some((m) => /over-budget|26,?200/.test(m)), "the $26,200 listing must never appear — it's over the stated $25,000 maximum");

  const matchCard = messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the in-budget listing must still be surfaced");
  assert.match(
    matchCard!,
    /Description: Rolex Daytona 116500LN black dial, pre-owned, box and papers, based in USA/,
    "every surfaced card must include its description"
  );
  assert.match(matchCard!, /Listing: https:\/\/watchfacts\.com\/flash-sales\/in-budget/, "must include the working URL");
  assert.equal(messages.filter((m) => /Potential Match/.test(m)).length, 1, "only the one in-budget listing should be surfaced");
});

test("required regression: a broken listing URL is omitted from the card entirely, never sent as a dead link", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      fsRow("still-valid", {
        brand: "Rolex",
        ref: "116500LN",
        price: "24500",
        description: "Rolex Daytona 116500LN, pre-owned",
        detailUrl: "https://watchfacts.com/flash-sales/broken-uuid",
      }),
    ],
    new Date().toISOString()
  );

  const urlValidator = require("../watchfacts/urlValidator") as typeof import("../watchfacts/urlValidator");
  t.mock.method(urlValidator, "getValidatedListingUrl", async () => undefined); // simulates the reported 500/broken response

  const messages = await freshSearch(t, "19990005555", "Rolex Daytona 116500LN");
  const matchCard = messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the match itself is unaffected by a broken detail URL");
  assert.doesNotMatch(matchCard!, /Listing:/, "a broken URL must be omitted, never sent as a dead link");
  assert.match(matchCard!, /Description: Rolex Daytona 116500LN, pre-owned/, "description must still be present regardless of URL validity");
});

test('required regression: a price like "under $20000" is never treated as a requested reference', async (t) => {
  await inventoryDb._resetDbForTests();
  // Note: "$20,000" (with a comma) was never actually at risk — the comma already breaks
  // \d{4,6}'s continuous-digit requirement. "$20000" (no comma) is the real failure case:
  // without the fix, "20000" fits the reference shape exactly like a real 5-digit reference.
  await inventoryDb.upsertListings(
    [fsRow("budget-1", { brand: "Rolex", description: "Rolex Submariner, great condition" })],
    new Date().toISOString()
  );

  const messages = await freshSearch(t, "19990002222", "Rolex under $20000");
  assert.ok(
    messages.some((m) => /Potential Match/.test(m)),
    "treating 20000 as a reference would incorrectly force an exact-match-only search and hide this real listing"
  );
});
