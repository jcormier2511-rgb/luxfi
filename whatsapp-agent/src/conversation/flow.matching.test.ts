import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR — same reasoning as flow.entitlement.test.ts.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-matching-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("../admin/store") as typeof import("../admin/store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
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

/** Walks a fresh contact through the once-per-contact preference questions with "any" each time. */
async function freshSearch(phone: string, query: string): Promise<string[]> {
  return freshSearchWithPreferences(phone, query, "any", "any", "any", "any");
}

async function freshSearchWithPreferences(
  phone: string,
  query: string,
  price: string,
  location: string,
  dial: string,
  condition: string
): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, query));
  push(await handleIncomingMessage(phone, price));
  push(await handleIncomingMessage(phone, location));
  push(await handleIncomingMessage(phone, dial));
  push(await handleIncomingMessage(phone, condition));
  return collected;
}

test("required regression: no exact reference available → no results, Fi starts monitoring instead of showing a wrong watch", async () => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [fsRow("wrong-ref", { brand: "Rolex", ref: "116508-0013", description: "Rolex Daytona bundle lot" })],
    new Date().toISOString()
  );

  const messages = await freshSearch("19990001111", "buy: Rolex Daytona 116500LN");
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

  const messages = await freshSearchWithPreferences(
    "19990004444",
    "buy: Rolex Daytona 116500 black dial pre-owned",
    "under 25000",
    "USA",
    "black",
    "pre-owned"
  );

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

  const messages = await freshSearch("19990005555", "buy: Rolex Daytona 116500LN");
  const matchCard = messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the match itself is unaffected by a broken detail URL");
  assert.doesNotMatch(matchCard!, /Listing:/, "a broken URL must be omitted, never sent as a dead link");
  assert.match(matchCard!, /Description: Rolex Daytona 116500LN, pre-owned/, "description must still be present regardless of URL validity");
});

test("required: a real search card includes 'Active in N monitored dealer groups' when the listing's contact has genuine group-posting history, via the actual flow.ts wiring (not just formatMatchCard in isolation)", async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await adminStore.initAdminSchema();
  await postingsDb.withSchema((pool) => pool.query("DELETE FROM approved_groups"));

  const sellerPhone = "19995559999";
  await postingsDb.withSchema(async (pool) => {
    await pool.query(
      `INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled,platform) VALUES('Miami Watch Traders','flow-groups-g1','active',true,'whatsapp')`
    );
    const canonicalUserId = (await pool.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO linked_identities(canonical_user_id,platform,identity) VALUES($1,'whatsapp',$2)", [canonicalUserId, sellerPhone]);
    await pool.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,canonical_user_id,type,original_text,brand,expires_at)
       VALUES('whatsapp','chat','flow-groups-g1',$1,'FS','FS Rolex FLOWGROUPS $9000','Rolex',now()+interval '15 days')`,
      [canonicalUserId]
    );
  });

  await inventoryDb.upsertListings(
    [fsRow("flow-groups-listing", { brand: "Rolex", ref: "FLOWGROUPS", contactPhone: sellerPhone, description: "Rolex, from a dealer active in monitored groups" })],
    new Date().toISOString()
  );

  const messages = await freshSearch("19990009999", "buy: Rolex FLOWGROUPS");
  const matchCard = messages.find((m) => /Potential Match/.test(m));
  assert.ok(matchCard, "the listing must still be surfaced");
  assert.match(matchCard!, /Active in 1 monitored dealer group\b/);
});

test('required regression: a price like "under $20000" is never treated as a requested reference', async () => {
  await inventoryDb._resetDbForTests();
  // Note: "$20,000" (with a comma) was never actually at risk — the comma already breaks
  // \d{4,6}'s continuous-digit requirement. "$20000" (no comma) is the real failure case:
  // without the fix, "20000" fits the reference shape exactly like a real 5-digit reference.
  await inventoryDb.upsertListings(
    [fsRow("budget-1", { brand: "Rolex", description: "Rolex Submariner, great condition" })],
    new Date().toISOString()
  );

  const messages = await freshSearch("19990002222", "buy: Rolex under $20000");
  assert.ok(
    messages.some((m) => /Potential Match/.test(m)),
    "treating 20000 as a reference would incorrectly force an exact-match-only search and hide this real listing"
  );
});
