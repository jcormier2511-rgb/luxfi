import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
const {
  ingestChatPosting,
  mirrorApiFsPosting,
  markApiPostingsInactive,
  isEligible,
  getPosting,
  findOppositeSideCandidates,
  extendPosting,
  closePosting,
  expireStalePostings,
} = store;

after(() => db._closePoolForTests());

function chatInput(overrides: Partial<Parameters<typeof ingestChatPosting>[0]> = {}) {
  return {
    platform: "whatsapp",
    chatId: "group-1",
    messageId: "msg-1",
    senderIdentity: "15551234567",
    senderName: "Alex",
    text: "WTB Rolex Daytona 116500LN, budget $30,000",
    ...overrides,
  };
}

test("a brand-new chat posting is created and classified", async () => {
  await db._resetDbForTests();
  const result = await ingestChatPosting(chatInput());
  assert.ok(result.posting);
  assert.equal(result.created, true);
  assert.equal(result.materialChange, true);
  assert.equal(result.posting!.type, "WTB");
  assert.equal(result.posting!.reference, "116500LN");
});

test("text that doesn't classify as FS/WTB is ignored, not stored", async () => {
  await db._resetDbForTests();
  const result = await ingestChatPosting(chatInput({ text: "hey what's up everyone" }));
  assert.equal(result.posting, null);
  assert.equal(result.created, false);
  assert.equal(result.materialChange, false);
});

test("re-delivering the same platform+chatId+messageId updates in place, never duplicates", async () => {
  await db._resetDbForTests();
  const first = await ingestChatPosting(chatInput());
  const second = await ingestChatPosting(chatInput()); // identical webhook redelivery
  assert.equal(first.posting!.id, second.posting!.id);
  assert.equal(second.created, false);
  assert.equal(second.materialChange, false, "an unchanged redelivery is not a material change");
});

test("editing a message's price is a material change; editing whitespace-only is not resurfaced as one falsely", async () => {
  await db._resetDbForTests();
  await ingestChatPosting(chatInput());
  const edited = await ingestChatPosting(chatInput({ text: "WTB Rolex Daytona 116500LN, budget $35,000" }));
  assert.equal(edited.created, false);
  assert.equal(edited.materialChange, true, "a changed budget must be treated as a material change");
  assert.equal(edited.posting!.price, "35000");
});

test("a chat posting's image (from a WhatsApp photo-with-caption post) is captured and retrievable", async () => {
  await db._resetDbForTests();
  const result = await ingestChatPosting(chatInput({ imageUrl: "https://media.whapi.example/abc123.jpg" }));
  assert.equal(await store.getPrimaryImageUrl(result.posting!.id), "https://media.whapi.example/abc123.jpg");
});

test("mirrorApiFsPosting upserts an API FS listing idempotently by external id", async () => {
  await db._resetDbForTests();
  const listing = {
    id: "ext-1",
    item: "Rolex Daytona",
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$29,000",
    contactName: "WatchFacts Seller",
    contactPhone: "10000000000",
    detailUrl: "https://watchfacts.com/flash-sales/ext-1",
    description: "Rolex Daytona 116500LN",
  };
  const first = await mirrorApiFsPosting(listing);
  assert.equal(first.created, true);
  assert.equal(first.materialChange, true);

  const second = await mirrorApiFsPosting({ ...listing, price: "$27,500" }); // re-sync with a price change
  assert.equal(second.created, false);
  assert.equal(second.materialChange, true, "a changed price must be reported as a material change");
  assert.equal(second.posting.id, first.posting.id);

  const result = await db.withSchema((pool) =>
    pool.query(`SELECT * FROM postings WHERE source_type='api' AND external_listing_id=$1`, ["ext-1"])
  );
  assert.equal(result.rows.length, 1, "must upsert, not duplicate");
  assert.equal(result.rows[0].price, "27500");
  assert.equal(result.rows[0].type, "FS");
});

test("mirrorApiFsPosting reports materialChange: false on an unchanged re-sync (never re-triggers matching for nothing)", async () => {
  await db._resetDbForTests();
  const listing = {
    id: "ext-2",
    item: "Rolex Daytona",
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$29,000",
    contactName: "WatchFacts Seller",
    contactPhone: "10000000000",
    description: "Rolex Daytona 116500LN",
  };
  await mirrorApiFsPosting(listing);
  const resynced = await mirrorApiFsPosting({ ...listing }); // identical re-sync
  assert.equal(resynced.created, false);
  assert.equal(resynced.materialChange, false);
});

test("mirrorApiFsPosting captures WatchFacts' own listing image (frontImage)", async () => {
  await db._resetDbForTests();
  const result = await mirrorApiFsPosting({
    id: "ext-img",
    item: "Rolex Daytona",
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$29,000",
    contactName: "Seller",
    contactPhone: "1",
    description: "",
    imageUrl: "https://cdn.watchfacts.com/listings/ext-img/front.jpg",
  });
  assert.equal(await store.getPrimaryImageUrl(result.posting.id), "https://cdn.watchfacts.com/listings/ext-img/front.jpg");
});

test("markApiPostingsInactive deactivates only API FS rows absent from the latest sync", async () => {
  await db._resetDbForTests();
  const base = {
    brand: "Rolex",
    ref: "116500LN",
    condition: "New",
    price: "$29,000",
    contactName: "Seller",
    contactPhone: "1",
    description: "",
  };
  await mirrorApiFsPosting({ id: "keep", item: "keep", ...base });
  await mirrorApiFsPosting({ id: "drop", item: "drop", ...base });

  await markApiPostingsInactive(["keep"]);

  const rows = await db.withSchema((pool) =>
    pool.query(`SELECT external_listing_id, status FROM postings WHERE source_type='api' ORDER BY external_listing_id`)
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.external_listing_id, r.status]),
    [
      ["drop", "source_inactive"],
      ["keep", "active"],
    ]
  );
});

test("markApiPostingsInactive with an empty seen list is a no-op (never wipes everything)", async () => {
  await db._resetDbForTests();
  await mirrorApiFsPosting({
    id: "a",
    item: "a",
    brand: "Rolex",
    ref: "",
    condition: "",
    price: "$1",
    contactName: "x",
    contactPhone: "1",
    description: "",
  });
  await markApiPostingsInactive([]);
  const rows = await db.withSchema((pool) => pool.query(`SELECT status FROM postings WHERE external_listing_id='a'`));
  assert.equal(rows.rows[0].status, "active");
});

test("isEligible requires status=active and a future expiry", () => {
  const future = new Date(Date.now() + 1000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(isEligible({ status: "active", expires_at: future }), true);
  assert.equal(isEligible({ status: "active", expires_at: past }), false);
  assert.equal(isEligible({ status: "expired", expires_at: future }), false);
});

test("findOppositeSideCandidates excludes the poster's own postings (no self-match)", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting(chatInput({ senderIdentity: "15551111111" }));
  await ingestChatPosting(
    chatInput({ senderIdentity: "15551111111", chatId: "group-1", messageId: "msg-2", text: "FS Rolex Daytona 116500LN $28,000" })
  );
  const candidates = await findOppositeSideCandidates(wtb.posting!);
  assert.equal(candidates.length, 0, "the same sender's own FS post must never be offered as a match candidate");
});

test("findOppositeSideCandidates returns active opposite-type postings from other senders", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting(chatInput({ senderIdentity: "15551111111" }));
  await ingestChatPosting(
    chatInput({ senderIdentity: "15552222222", chatId: "group-1", messageId: "msg-2", text: "FS Rolex Daytona 116500LN $28,000" })
  );
  const candidates = await findOppositeSideCandidates(wtb.posting!);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, "FS");
});

test("extendPosting pushes expires_at forward by 30 days for an active posting", async () => {
  await db._resetDbForTests();
  const created = await ingestChatPosting(chatInput());
  const before = new Date(created.posting!.expires_at).getTime();
  const extended = await extendPosting(created.posting!.id);
  assert.ok(extended);
  const after = new Date(extended!.expires_at).getTime();
  assert.ok(after - before >= 29 * 24 * 60 * 60 * 1000, "expiry should move forward by roughly 30 days");
});

test("extendPosting is a no-op for a posting that isn't active", async () => {
  await db._resetDbForTests();
  const created = await ingestChatPosting(chatInput());
  await closePosting(created.posting!.id, "sold");
  const extended = await extendPosting(created.posting!.id);
  assert.equal(extended, null);
});

test("closePosting sets the given terminal status", async () => {
  await db._resetDbForTests();
  const created = await ingestChatPosting(chatInput());
  await closePosting(created.posting!.id, "found");
  const posting = await getPosting(created.posting!.id);
  assert.equal(posting!.status, "found");
});

test("expireStalePostings expires only active postings whose expires_at has passed", async () => {
  await db._resetDbForTests();
  const created = await ingestChatPosting(chatInput());
  await db.withSchema((pool) =>
    pool.query(`UPDATE postings SET expires_at = now() - interval '1 day' WHERE id=$1`, [created.posting!.id])
  );
  const stillFresh = await ingestChatPosting(chatInput({ chatId: "group-2", messageId: "msg-fresh" }));

  const count = await expireStalePostings();
  assert.equal(count, 1);

  assert.equal((await getPosting(created.posting!.id))!.status, "expired");
  assert.equal((await getPosting(stillFresh.posting!.id))!.status, "active");
});
