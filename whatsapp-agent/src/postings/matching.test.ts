import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const matching = require("./matching") as typeof import("./matching");
const { scoreMatch, upsertMatch, runImmediateMatch, runReconciliation } = matching;
const { ingestChatPosting } = store;

after(() => db._closePoolForTests());

type Posting = Parameters<typeof scoreMatch>[0];

function posting(overrides: Partial<Posting> = {}): Posting {
  return {
    id: 1,
    source_platform: "whatsapp",
    source_type: "chat",
    source_chat_id: "g1",
    source_message_id: "m1",
    external_listing_id: null,
    canonical_user_id: 1,
    source_identity: "1",
    type: "FS",
    original_text: "",
    brand: "",
    reference: "",
    condition: "",
    price: null,
    currency: "USD",
    location: "",
    contact_name: "",
    contact_phone: "",
    detail_url: "",
    status: "active",
    approved_match_count: 0,
    expires_at: new Date(Date.now() + 1000000).toISOString(),
    ...overrides,
  } as Posting;
}

test("scoreMatch: exact reference match scores highest and is case-insensitive", () => {
  const fs = posting({ type: "FS", reference: "116500ln" });
  const wtb = posting({ type: "WTB", reference: "116500LN" });
  const result = scoreMatch(fs, wtb);
  assert.ok(result);
  assert.equal(result!.score, 100);
  assert.ok(result!.reasons.some((r) => /Exact reference/.test(r)));
});

test("scoreMatch: never falls back to a same-brand match when both sides specified different references", () => {
  const fs = posting({ brand: "Rolex", reference: "116500LN" });
  const wtb = posting({ brand: "Rolex", reference: "126710BLRO" });
  assert.equal(scoreMatch(fs, wtb), null, "a stated reference mismatch must never be papered over by same-brand");
});

test("scoreMatch: same brand is still a fallback when only one side specified a reference", () => {
  const fs = posting({ brand: "Rolex", reference: "116500LN" });
  const wtb = posting({ brand: "Rolex", reference: "" }); // no reference stated on the WTB side
  const result = scoreMatch(fs, wtb);
  assert.ok(result);
  assert.equal(result!.score, 20);
});

test("scoreMatch: reference equality is normalized (formatting differences don't block a real match)", () => {
  const fs = posting({ reference: "116508-0013" });
  const wtb = posting({ reference: "1165080013" }); // same reference, no dash
  const result = scoreMatch(fs, wtb);
  assert.ok(result);
  assert.equal(result!.score, 100);
});

test("scoreMatch: a bare base reference matches a listing's suffixed variant of the same watch", () => {
  const fs = posting({ reference: "116500LN" });
  const wtb = posting({ reference: "116500" }); // buyer typed the base reference with no dial-code suffix
  const result = scoreMatch(fs, wtb);
  assert.ok(result, "116500 must still find the 116500LN listing");
  assert.equal(result!.score, 100);
});

test("required regression: a bare base reference never matches a different reference that happens to share a prefix", () => {
  const fs = posting({ reference: "116508-0013" });
  const wtb = posting({ reference: "116500" });
  assert.equal(scoreMatch(fs, wtb), null, "116500 and 116508-0013 are different watches, not a prefix family");
});

test("scoreMatch: a broad match is allowed only when WTB gave no reference or brand at all", () => {
  const fs = posting({ brand: "Rolex", reference: "116500LN" });
  const wtb = posting({ brand: "", reference: "" });
  const result = scoreMatch(fs, wtb);
  assert.ok(result);
  assert.equal(result!.score, 5);
});

test("scoreMatch: no match when brands differ and WTB did specify a brand", () => {
  const fs = posting({ brand: "Omega", reference: "" });
  const wtb = posting({ brand: "Rolex", reference: "" });
  assert.equal(scoreMatch(fs, wtb), null);
});

test("scoreMatch: a hard max bid is respected even on an otherwise-exact reference match", () => {
  const fs = posting({ reference: "116500LN", price: "35000" });
  const wtb = posting({ reference: "116500LN", price: "30000" });
  assert.equal(scoreMatch(fs, wtb), null);
});

test("scoreMatch: within-budget adds a reason but doesn't change the base score", () => {
  const fs = posting({ reference: "116500LN", price: "28000" });
  const wtb = posting({ reference: "116500LN", price: "30000" });
  const result = scoreMatch(fs, wtb);
  assert.equal(result!.score, 100);
  assert.ok(result!.reasons.some((r) => /Within budget/.test(r)));
});

test("required regression: the budget reason formats amounts with thousands separators, not raw digit strings", () => {
  const fs = posting({ reference: "116500LN", price: "25000" });
  const wtb = posting({ reference: "116500LN", price: "25000" });
  const result = scoreMatch(fs, wtb);
  assert.ok(result!.reasons.some((r) => r === "Within budget ($25,000 ≤ $25,000)"), `got: ${JSON.stringify(result!.reasons)}`);
});

test("upsertMatch creates a new match at revision 1", async () => {
  await db._resetDbForTests();
  const fs = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  const result = await upsertMatch(fs.posting!.id, wtb.posting!.id, { score: 100, reasons: ["Exact reference match"] });
  assert.equal(result.revision, 1);
  assert.equal(result.isNewOrChanged, true);
});

test("upsertMatch is a no-op (same revision) when re-discovering an identical match", async () => {
  await db._resetDbForTests();
  const fs = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  const first = await upsertMatch(fs.posting!.id, wtb.posting!.id, { score: 100, reasons: ["Exact reference match"] });
  const second = await upsertMatch(fs.posting!.id, wtb.posting!.id, { score: 100, reasons: ["Exact reference match"] });
  assert.equal(second.matchId, first.matchId);
  assert.equal(second.revision, 1);
  assert.equal(second.isNewOrChanged, false);
});

test("upsertMatch bumps the revision when the score/reasons genuinely change", async () => {
  await db._resetDbForTests();
  const fs = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });

  const first = await upsertMatch(fs.posting!.id, wtb.posting!.id, { score: 100, reasons: ["Exact reference match"] });
  const second = await upsertMatch(fs.posting!.id, wtb.posting!.id, { score: 20, reasons: ["Same brand"] });
  assert.equal(second.matchId, first.matchId);
  assert.equal(second.revision, 2);
  assert.equal(second.isNewOrChanged, true);
});

test("runImmediateMatch finds a match against an eligible opposite-side posting and creates it", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });

  const result = await runImmediateMatch(wtb.posting!);
  assert.equal(result.matchesFound, 1);

  const matches = await db.withSchema((pool) => pool.query(`SELECT * FROM matches`));
  assert.equal(matches.rows.length, 1);
  assert.equal(matches.rows[0].score, 100);
});

test("a broken image lookup during notification never blocks the match itself — falls back to text-only", async (t) => {
  await db._resetDbForTests();
  t.mock.method(store, "getPrimaryImageUrl", async () => {
    throw new Error("simulated image lookup failure");
  });

  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });

  const result = await runImmediateMatch(wtb.posting!);
  assert.equal(result.matchesFound, 1, "an image-lookup failure must never prevent a match from being found/recorded");

  const matches = await db.withSchema((pool) => pool.query(`SELECT * FROM matches`));
  assert.equal(matches.rows.length, 1);
});

test("an image lookup failure on one candidate never aborts matching against the remaining candidates in the same pass", async (t) => {
  await db._resetDbForTests();
  t.mock.method(store, "getPrimaryImageUrl", async () => {
    throw new Error("simulated image lookup failure");
  });

  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "buyer",
    text: "WTB Rolex budget $30,000", // no reference — same-brand match against every FS below
  });
  for (let i = 0; i < 3; i++) {
    await ingestChatPosting({
      platform: "whatsapp",
      chatId: "g1",
      messageId: `fs${i}`,
      senderIdentity: `seller-${i}`,
      text: `FS Rolex Daytona 11650${i}LN $10,000`,
    });
  }

  const result = await runImmediateMatch(wtb.posting!);
  assert.equal(result.matchesFound, 3, "every eligible candidate must still be matched even though each notification's image lookup fails");
});

test("runImmediateMatch never matches a user against their own opposite-side posting", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "same-user",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "same-user",
    text: "FS Rolex Daytona 116500LN $28,000",
  });

  const result = await runImmediateMatch(wtb.posting!);
  assert.equal(result.matchesFound, 0);
});

test("runImmediateMatch on an ineligible (inactive) posting finds nothing", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  await store.closePosting(wtb.posting!.id, "stopped");
  const stale = await store.getPosting(wtb.posting!.id);

  const result = await runImmediateMatch(stale!);
  assert.equal(result.matchesFound, 0);
});

test("runReconciliation recovers a match the immediate path missed, without duplicating an already-known one", async () => {
  await db._resetDbForTests();
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb1",
    senderIdentity: "2",
    text: "WTB Rolex Daytona 116500LN budget $30,000",
  });
  const fs = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "fs1",
    senderIdentity: "1",
    text: "FS Rolex Daytona 116500LN $28,000",
  });

  // Simulate the immediate-match path having been skipped entirely (e.g. a process crash).
  const first = await runReconciliation();
  assert.equal(first.matchesCreatedOrChanged, 1);

  // A second sweep over the same unchanged pair must not create/re-flag a second match.
  const second = await runReconciliation();
  assert.equal(second.matchesCreatedOrChanged, 0);

  const matches = await db.withSchema((pool) =>
    pool.query(`SELECT * FROM matches WHERE fs_posting_id=$1 AND wtb_posting_id=$2`, [fs.posting!.id, wtb.posting!.id])
  );
  assert.equal(matches.rows.length, 1, "reconciliation must never create duplicate match rows for the same pair");
});

test("an explicit dial/condition conflict rejects a match, but a blank FS value (unrecorded, not conflicting) does not", () => {
  const baseFs = posting({ reference: "116500LN", dial: "white", condition: "pre-owned", location: "USA" });
  const baseWtb = posting({ type: "WTB", reference: "116500LN", dial: "white", condition: "pre-owned", location: "US" });
  assert.ok(scoreMatch(baseFs, baseWtb));
  assert.equal(scoreMatch({ ...baseFs, dial: "black" }, baseWtb), null, "dial mismatch");
  assert.ok(scoreMatch({ ...baseFs, dial: "" }, baseWtb), "a listing that never recorded a dial color isn't a conflict");
  assert.equal(scoreMatch({ ...baseFs, condition: "new" }, baseWtb), null, "condition mismatch");
  assert.ok(scoreMatch({ ...baseFs, condition: "" }, baseWtb), "a listing that never recorded a condition isn't a conflict");
});

test("location is informational only and never gates a match — inventory ships beyond one city, and FS listings are often tagged with a broad region rather than a city", () => {
  const baseFs = posting({ reference: "116500LN", location: "North America" });
  const baseWtb = posting({ type: "WTB", reference: "116500LN", location: "Miami" });
  assert.ok(scoreMatch(baseFs, baseWtb), "a region/city granularity mismatch must not block an otherwise-exact reference match");
  assert.ok(scoreMatch({ ...baseFs, location: "" }, baseWtb), "a listing with no location recorded must not block a match either");
});

test("cross-currency budgets are converted before comparison", async (t) => {
  const currency = require("../matching/currency") as typeof import("../matching/currency");
  currency.setExchangeRateProviderForTests(async (code) => code === "EUR" ? 1.2 : null);
  t.after(() => currency.setExchangeRateProviderForTests());
  const fs = posting({ reference: "116500LN", price: "24000", currency: "EUR" });
  const enough = posting({ type: "WTB", reference: "116500LN", price: "30000", currency: "USD" });
  const tooLow = posting({ type: "WTB", reference: "116500LN", price: "28000", currency: "USD" });
  assert.ok(await matching.scoreMatchWithCurrency(fs, enough));
  assert.equal(await matching.scoreMatchWithCurrency(fs, tooLow), null);
});
