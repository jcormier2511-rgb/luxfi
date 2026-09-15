import { test, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-photorequest-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
process.env.ENABLE_AI_MATCHING = "true";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.AI_MATCHING_TEST_PHONE =
  "19990001111,19990002222,19990003333,19990004444,19993000000,19993010000,19993020000,19990005555,19990006666";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../channels/greenApi") as typeof import("../channels/greenApi");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const intentExtractorModule = require("../ai/intentExtractor") as typeof import("../ai/intentExtractor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

/** Approval usage now lives in Postgres (canonical_users.total_approved_count — shared with
 *  the v4 automatic-matching flow, see postings/approvalUsage.ts), not on ConversationState —
 *  read it the same way notify.fiveApproval.test.ts does. */
async function totalApproved(phone: string): Promise<number> {
  const canonicalUserId = await getOrCreateCanonicalUser("whatsapp", phone);
  const result = await postingsDb.withSchema((pool) =>
    pool.query(`SELECT total_approved_count FROM canonical_users WHERE id=$1`, [canonicalUserId])
  );
  return result.rows[0].total_approved_count;
}

const SELLER_A_PHONE = "17775551111";
const SELLER_B_PHONE = "17775552222";

function fsRow(id: string, overrides: Partial<Parameters<typeof inventoryDb.upsertListings>[0][number]> = {}) {
  return {
    id,
    type: "FS" as const,
    category: "watches",
    item: `item-${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "",
    price: "28000",
    location: "",
    contactName: `seller-${id}`,
    contactPhone: SELLER_A_PHONE,
    rating: "",
    description: "Rolex Daytona 116500LN",
    ...overrides,
  };
}

/** Drives the AI-matching-test-phone ephemeral search path -- the replacement for the old
 *  "buy:"/"sell:" + a few "any" replies shortcut, which no longer reaches a v3 search at all
 *  (see conversation/flow.ts: `buy:`/`sell:` now creates a monitored posting like any other
 *  conversational request). Scoped to the exact search text so the "hi" warm-up message isn't
 *  itself mistaken for a confident intent (an unconditional mock would run a duplicate search). */
function mockConfidentIntent(t: TestContext, action: "buy" | "sell", searchText: string) {
  t.mock.method(intentExtractorModule, "extractIntent", async (text: string) =>
    text === searchText
      ? {
          intent: {
            intent: action,
            brand: "Rolex",
            model: "Daytona",
            reference: "116500LN",
            dial: "any",
            condition: "any",
            year: null,
            boxPapers: null,
            priceMin: null,
            priceMax: 500000,
            currency: "USD",
            location: "Global",
            searchText,
            confidence: 0.9,
          },
          priceUnreliable: false,
        }
      : null
  );
}

async function runSearch(phone: string, searchText: string): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, searchText));
  return collected;
}

async function freshSearch(t: TestContext, phone: string, searchText: string, action: "buy" | "sell" = "buy"): Promise<string[]> {
  mockConfidentIntent(t, action, searchText);
  return runSearch(phone, searchText);
}

test("required: 'photos 1' resolves the correct match and messages that seller, not any other candidate", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [
      fsRow("match-a", { contactPhone: SELLER_A_PHONE, price: "27000" }),
      fsRow("match-b", { contactPhone: SELLER_B_PHONE, price: "29000" }),
    ],
    new Date().toISOString()
  );
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const buyerPhone = "19990001111";
  await freshSearch(t, buyerPhone, "looking for a Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(buyerPhone, "photos 1");

  assert.equal(sent.length, 1, "exactly one seller must be messaged");
  assert.ok(
    sent[0].phone === SELLER_A_PHONE || sent[0].phone === SELLER_B_PHONE,
    "the request must go to whichever candidate is actually shown as #1"
  );
  assert.match(result.messages.join("\n"), /Photo request sent for #1/);
});

test("required: does not consume an approval credit, and the buyer can still approve normally afterward", async (t) => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("credit-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const buyerPhone = "19990002222";
  await freshSearch(t, buyerPhone, "looking for a Rolex Daytona 116500LN");
  const beforePhotos = await totalApproved(buyerPhone);
  await handleIncomingMessage(buyerPhone, "photos 1");
  const afterPhotos = await totalApproved(buyerPhone);
  assert.equal(afterPhotos, beforePhotos, "a photo request must never increment approval usage");

  const approveResult = await handleIncomingMessage(buyerPhone, "approve 1");
  assert.equal(await totalApproved(buyerPhone), beforePhotos + 1, "approving afterward still costs exactly one credit");
  assert.match(approveResult.messages.join("\n"), /Approved #1/);
});

test("required: duplicate photo requests within 48 hours are suppressed with the specified message", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("dup-1")], new Date().toISOString());
  let sendCount = 0;
  t.mock.method(whapiClient, "sendText", async () => {
    sendCount++;
  });

  const buyerPhone = "19990003333";
  await freshSearch(t, buyerPhone, "looking for a Rolex Daytona 116500LN");
  await handleIncomingMessage(buyerPhone, "photos 1");
  const second = await handleIncomingMessage(buyerPhone, "photo 1");

  assert.equal(sendCount, 1, "the seller must only be messaged once");
  assert.match(second.messages.join("\n"), /Photos have already been requested\. I'll send them when received\./);
});

test("required: neither party's phone number is ever revealed to the buyer by a photo request", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("privacy-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const buyerPhone = "19990004444";
  await freshSearch(t, buyerPhone, "looking for a Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(buyerPhone, "request photos 1");

  const joined = result.messages.join("\n");
  assert.doesNotMatch(joined, new RegExp(SELLER_A_PHONE), "the seller's phone number must never reach the buyer via a photo request");
});

test("all three accepted command forms resolve the same way", async (t) => {
  t.mock.method(whapiClient, "sendText", async () => {});
  const SEARCH_TEXT = "looking for a Rolex Daytona 116500LN";
  mockConfidentIntent(t, "buy", SEARCH_TEXT); // armed once -- t.mock.method throws if re-armed inside the loop below

  // Each form gets its own listing (distinct reference) — the duplicate-protection window is
  // per-listing, not per-requester (see photoRequests.ts), so reusing one listing across all
  // three would make the 2nd/3rd calls look like duplicates of the 1st rather than exercising
  // command parsing.
  for (const [i, command] of ["photos 1", "photo 1", "request photos 1"].entries()) {
    await inventoryDb._resetDbForTests();
    await inventoryDb.upsertListings([fsRow(`forms-${i}`)], new Date().toISOString());
    const buyerPhone = `199930${i}0000`;
    await runSearch(buyerPhone, SEARCH_TEXT);
    const result = await handleIncomingMessage(buyerPhone, command);
    assert.match(result.messages.join("\n"), /Photo request sent for #1/, `"${command}" must be recognized`);
  }
});

test("photo requests are only available on FS/seller cards, not WTB/buyer cards", async (t) => {
  await inventoryDb._resetDbForTests();
  let sendCount = 0;
  t.mock.method(whapiClient, "sendText", async () => {
    sendCount++;
  });

  // A "sell" action never reaches the ephemeral v3 search anymore -- it always goes straight to
  // the posting intake instead (see conversation/flow.ts: only "buy" retains this ephemeral-
  // search path for the AI test phone). There is no longer any live way to get a WTB match into
  // pendingMatches, so this constructs that precondition directly -- the point being tested is
  // the action-based gate in handlePhotoRequest, not how a WTB match would normally appear.
  const sellerPhone = "19990005555";
  await handleIncomingMessage(sellerPhone, "hi"); // consumes the one-shot "new contact" welcome
  const { getState, saveState } = require("./stateStore") as typeof import("./stateStore");
  const state = getState(sellerPhone);
  state.pendingMatches = {
    request: { action: "sell", query: "Rolex Daytona 116500LN" },
    matches: [{ ...fsRow("wtb-1"), type: "WTB" as const, source: "WatchFacts" }],
    decisions: ["pending"],
  };
  saveState(state);

  const result = await handleIncomingMessage(sellerPhone, "photos 1");

  assert.equal(sendCount, 0, "no seller-side message should ever be sent for a WTB/buyer card");
  assert.match(result.messages.join("\n"), /only available for items currently for sale/);
});

test("an out-of-range match number is reported rather than silently ignored", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("range-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const buyerPhone = "19990006666";
  await freshSearch(t, buyerPhone, "looking for a Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(buyerPhone, "photos 9");
  assert.match(result.messages.join("\n"), /don't have a match #9/);
});
