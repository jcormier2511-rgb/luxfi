import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-photorequest-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getOrCreateCanonicalUser } = require("../postings/identity") as typeof import("../postings/identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
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

async function freshSearch(phone: string, query: string): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, query));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
  push(await handleIncomingMessage(phone, "any"));
  return collected;
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
  await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
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
  await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
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
  await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
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
  await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(buyerPhone, "request photos 1");

  const joined = result.messages.join("\n");
  assert.doesNotMatch(joined, new RegExp(SELLER_A_PHONE), "the seller's phone number must never reach the buyer via a photo request");
});

test("all three accepted command forms resolve the same way", async (t) => {
  t.mock.method(whapiClient, "sendText", async () => {});

  // Each form gets its own listing (distinct reference) — the duplicate-protection window is
  // per-listing, not per-requester (see photoRequests.ts), so reusing one listing across all
  // three would make the 2nd/3rd calls look like duplicates of the 1st rather than exercising
  // command parsing.
  for (const [i, command] of ["photos 1", "photo 1", "request photos 1"].entries()) {
    await inventoryDb._resetDbForTests();
    await inventoryDb.upsertListings([fsRow(`forms-${i}`)], new Date().toISOString());
    const buyerPhone = `199930${i}0000`;
    await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
    const result = await handleIncomingMessage(buyerPhone, command);
    assert.match(result.messages.join("\n"), /Photo request sent for #1/, `"${command}" must be recognized`);
  }
});

test("photo requests are only available on FS/seller cards, not WTB/buyer cards", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings(
    [{ ...fsRow("wtb-1"), type: "WTB" as const }],
    new Date().toISOString()
  );
  let sendCount = 0;
  t.mock.method(whapiClient, "sendText", async () => {
    sendCount++;
  });

  const sellerPhone = "19990005555";
  await freshSearch(sellerPhone, "sell: Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(sellerPhone, "photos 1");

  assert.equal(sendCount, 0, "no seller-side message should ever be sent for a WTB/buyer card");
  assert.match(result.messages.join("\n"), /only available for items currently for sale/);
});

test("an out-of-range match number is reported rather than silently ignored", async (t) => {
  await inventoryDb._resetDbForTests();
  await inventoryDb.upsertListings([fsRow("range-1")], new Date().toISOString());
  t.mock.method(whapiClient, "sendText", async () => {});

  const buyerPhone = "19990006666";
  await freshSearch(buyerPhone, "buy: Rolex Daytona 116500LN");
  const result = await handleIncomingMessage(buyerPhone, "photos 9");
  assert.match(result.messages.join("\n"), /don't have a match #9/);
});
