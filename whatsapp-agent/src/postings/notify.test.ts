import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate PERSIST_DIR: approveMatch now also touches conversation state (markPendingEscrowOffer,
// see conversation/stateStore.ts) — without this, that would write real conversations.json rows
// into the repo's own ./persist (gitignored, but still stray/confusing to leave behind).
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-notify-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
// approveMatch/passMatch/notifyOneRecipient are now allowlist-gated at decision/notification
// time, not just at ingestion — these tests post into chat "g1", so v4 needs to be enabled
// for it here too (the allowlist mechanism itself is covered separately in
// config.allowedChatIds.test.ts / groupMonitor.allowedChatIds.test.ts).
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("./postingsStore") as typeof import("./postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const matching = require("./matching") as typeof import("./matching");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("./notify") as typeof import("./notify");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const whapiClient = require("../whapi/client") as typeof import("../whapi/client");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const telegramClient = require("../channels/telegram") as typeof import("../channels/telegram");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const identity = require("./identity") as typeof import("./identity");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notificationPreferences = require("./notificationPreferences") as typeof import("./notificationPreferences");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore = require("../admin/store") as typeof import("../admin/store");

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch, passMatch } = notify;

after(async () => {
  await adminStore._closePoolForTests();
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

let counter = 0;
/**
 * Creates one fresh WTB (chat) matched against a WatchFacts-API-mirrored FS listing — the
 * seller side has no WhatsApp identity, so there's no one to wait on for mutual confirmation
 * and a single approval reveals immediately (see notify.ts's approveMatch). This is exactly
 * what most of these tests want to exercise (entitlement/trial behavior), independent of the
 * separate mutual-consent chat-vs-chat connection behavior tested lower in this file.
 */
async function createMatch(buyerPhone: string): Promise<{ matchId: number; sellerPhone: string }> {
  const n = ++counter;
  const ref = `REF${n}`;
  const sellerPhone = `seller-${n}`;
  await mirrorApiFsPosting({
    id: `wf-${n}`,
    item: "Rolex",
    brand: "Rolex",
    ref,
    condition: "New",
    price: "$10,000",
    contactName: sellerPhone,
    contactPhone: sellerPhone,
    description: "",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `wtb-${n}`,
    senderIdentity: buyerPhone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return { matchId: matches.rows[0].id, sellerPhone };
}

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await entitlements._resetDbForTests();
  // Any approved_groups row flips the allowlist into database mode (hasDatabaseGroupAllowlist),
  // which would silently un-monitor chat "g1" for every test here — start each one clean.
  await adminStore.initAdminSchema();
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
  counter = 0;
}

test("approveMatch on an unknown match id is invalid", async () => {
  await resetAll();
  const outcome = await approveMatch(999999, "15550000000");
  assert.equal(outcome.status, "invalid");
});

test("presented match preserves every available decision field and remains approvable", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  await mirrorApiFsPosting({
    id: "dealer-listing-413",
    item: "Rolex Daytona",
    brand: "Rolex",
    model: "Daytona",
    ref: "116500LN",
    dial: "Black",
    year: "2023",
    boxPapers: "Full set",
    condition: "New",
    price: "$28,500",
    location: "Miami, USA",
    contactName: "ABC Watches",
    contactPhone: "dealer-413",
    detailUrl: "https://example.com/listings/413",
    imageUrl: "https://example.com/photos/413.jpg",
    description: "Rolex Daytona 116500LN black dial, 2023 full set",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp", chatId: "g1", messageId: "rich-card-wtb", senderIdentity: "buyer-rich-card",
    text: "WTB Rolex Daytona 116500LN black dial budget $30,000",
  });
  await runImmediateMatch(wtb.posting!);

  const card = sent.find((message) => message.phone === "buyer-rich-card")?.message;
  assert.ok(card);
  for (const expected of ["ABC Watches", "Rolex Daytona 116500LN", "Dial/Color: Black", "2023 • Full set • New", "$28,500", "Miami, USA", "Source: https://example.com/listings/413", "Photo: https://example.com/photos/413.jpg"]) {
    assert.match(card!, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `card should include ${expected}`);
  }
  assert.doesNotMatch(card!, /Candidate ID/, "the raw internal listing id is noise once the seller's own name is already shown");
  const matchId = Number(card!.match(/approve (\d+)/)?.[1]);
  assert.ok(Number.isInteger(matchId));
  const outcome = await approveMatch(matchId, "buyer-rich-card");
  assert.equal(outcome.status, "approved", "the exact delivered match remains actionable");
  assert.equal(outcome.match?.identity, "ABC Watches");
  assert.equal((await approveMatch(987654321, "buyer-rich-card")).status, "invalid", "unknown/expired IDs fail safely");
});

test("match card shows how many monitored dealer groups the counterpart is active in", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));
  await db.withSchema((pool) =>
    pool.query("INSERT INTO approved_groups(group_name,group_id,status,monitoring_enabled) VALUES('G1','g1','active',true),('G2','g2','active',true),('Paused','g3','inactive',true)")
  );
  // The seller has posted in two active groups and one inactive one.
  await ingestChatPosting({ platform: "whatsapp", chatId: "g2", messageId: "seller-elsewhere", senderIdentity: "seller-groups", text: "FS Rolex 126610LN $12,000" });
  await ingestChatPosting({ platform: "whatsapp", chatId: "g3", messageId: "seller-paused", senderIdentity: "seller-groups", text: "FS Rolex 126710BLRO $18,000" });
  await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "fs-groups", senderIdentity: "seller-groups", text: "FS Rolex GROUPS1 $10,000" });
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "wtb-groups", senderIdentity: "buyer-groups", text: "WTB Rolex GROUPS1 budget $12,000" });
  await runImmediateMatch(wtb.posting!);

  const buyerCard = sent.find((m) => m.phone === "buyer-groups")?.message;
  assert.ok(buyerCard);
  assert.match(buyerCard!, /Seller: seller-groups\nActive in 2 monitored dealer groups/, "line sits directly under the identity line");
  const sellerCard = sent.find((m) => m.phone === "seller-groups")?.message;
  assert.ok(sellerCard);
  assert.match(sellerCard!, /Buyer: buyer-groups\nActive in 1 monitored dealer group\n/, "singular form for one group");
  await db.withSchema((pool) => pool.query("DELETE FROM approved_groups"));
});

test("match card omits the groups line entirely when the counterpart is active in none", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));
  // API-mirrored seller: no canonical user at all, so there is nothing to count.
  await createMatch("buyer-no-groups");
  const buyerCard = sent.find((m) => m.phone === "buyer-no-groups")?.message;
  assert.ok(buyerCard);
  assert.doesNotMatch(buyerCard!, /monitored dealer group/);
  // Chat-vs-chat with no approved groups on file: still no line (never "Active in 0").
  const { matchId } = await createChatVsChatMatch("buyer-no-groups-2", "seller-no-groups-2");
  assert.ok(matchId);
  const card2 = sent.find((m) => m.phone === "buyer-no-groups-2")?.message;
  assert.ok(card2);
  assert.doesNotMatch(card2!, /monitored dealer group/);
});

test("approveMatch succeeds and returns the counterpart's contact info", async () => {
  await resetAll();
  const { matchId, sellerPhone } = await createMatch("buyer-1");
  const outcome = await approveMatch(matchId, "buyer-1");
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.counterpart!.phone, sellerPhone);
});

test("approveMatch is idempotent — a duplicate click on the same match is a no-op, not a double count", async () => {
  await resetAll();
  const { matchId, sellerPhone } = await createMatch("buyer-1");
  await approveMatch(matchId, "buyer-1");
  const again = await approveMatch(matchId, "buyer-1");
  assert.equal(again.status, "approved");
  assert.equal(again.counterpart!.phone, sellerPhone, "a duplicate click still reports the same, already-known contact info");

  const approvals = await db.withSchema((pool) => pool.query(`SELECT * FROM approvals WHERE match_id=$1`, [matchId]));
  assert.equal(approvals.rows.length, 1, "a duplicate approve must not insert a second approval row");
});

test("concurrent duplicate clicks on the same match are serialized atomically — exactly one approval, ledger row, and counter increment", async () => {
  await resetAll();
  const { matchId } = await createMatch("buyer-concurrent");

  // Real concurrent calls (not sequential) — this exercises the FOR UPDATE row locking +
  // ON CONFLICT DO NOTHING combination inside one transaction, not just JS-level sequencing.
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () => approveMatch(matchId, "buyer-concurrent"))
  );
  assert.ok(
    outcomes.every((o) => o.status === "approved"),
    "every concurrent click should resolve to the same approved outcome"
  );

  const approvals = await db.withSchema((pool) => pool.query(`SELECT * FROM approvals WHERE match_id=$1`, [matchId]));
  assert.equal(approvals.rows.length, 1, "concurrent duplicate clicks must still insert exactly one approval row");

  const ledger = await db.withSchema((pool) => pool.query(`SELECT * FROM billing_ledger WHERE match_id=$1`, [matchId]));
  assert.equal(ledger.rows.length, 1, "concurrent duplicate clicks must still insert exactly one ledger row");

  const canonicalUsers = await db.withSchema((pool) => pool.query(`SELECT total_approved_count FROM canonical_users`));
  assert.equal(canonicalUsers.rows[0].total_approved_count, 1, "the account-level counter must increment exactly once, not five times");
});

test("the first three approvals for an account are complimentary; the fourth is locked", async () => {
  await resetAll();
  const buyer = "buyer-trial";

  for (let i = 0; i < 3; i++) {
    const { matchId } = await createMatch(buyer);
    const outcome = await approveMatch(matchId, buyer);
    assert.equal(outcome.status, "approved", `approval #${i + 1} should succeed`);
  }

  const { matchId: fourthMatchId } = await createMatch(buyer);
  const fourth = await approveMatch(fourthMatchId, buyer);
  assert.equal(fourth.status, "locked");

  const approvals = await db.withSchema((pool) =>
    pool.query(`SELECT * FROM approvals a JOIN canonical_users u ON u.id = a.approving_canonical_user_id`)
  );
  assert.equal(approvals.rows.length, 3, "a locked attempt must never insert an approval row");
});

test("a returning-user Fi campaign bonus (fi_returning_promotions) unlocks a complimentary approval past the third, same as v3's evaluateApprovalGate", async () => {
  await resetAll();
  const buyer = "buyer-promo-bonus";

  let canonicalUserId!: number;
  for (let i = 0; i < 3; i++) {
    const { matchId } = await createMatch(buyer);
    const outcome = await approveMatch(matchId, buyer);
    assert.equal(outcome.status, "approved", `approval #${i + 1} should succeed`);
    if (i === 0) {
      canonicalUserId = (
        await db.withSchema((pool) => pool.query(`SELECT approving_canonical_user_id FROM approvals WHERE match_id=$1`, [matchId]))
      ).rows[0].approving_canonical_user_id;
    }
  }

  // Without a promo grant, the 4th is locked (already covered above) -- confirm that's still
  // true right up to the moment the grant exists, then grant it.
  const { matchId: fourthMatchId } = await createMatch(buyer);
  assert.equal((await approveMatch(fourthMatchId, buyer)).status, "locked");
  await db.withSchema((pool) =>
    pool.query(`INSERT INTO fi_returning_promotions (canonical_user_id, tasks_granted, tasks_used) VALUES ($1, 3, 0)`, [canonicalUserId])
  );

  const fourth = await approveMatch(fourthMatchId, buyer);
  assert.equal(fourth.status, "approved", "the promo grant must unlock this approval even past the 3-approval trial");

  const ledger = await db.withSchema((pool) => pool.query(`SELECT billing_status FROM billing_ledger ORDER BY id`));
  assert.equal(ledger.rows[3].billing_status, "complimentary", "a promo-granted approval must be billed the same as a trial one, never plan_included");

  const promo = await db.withSchema((pool) => pool.query(`SELECT tasks_used FROM fi_returning_promotions WHERE canonical_user_id=$1`, [canonicalUserId]));
  assert.equal(promo.rows[0].tasks_used, 1, "the grant is consumed by the approval it unlocked");
});

test("an admin manual override unlocks approvals past the third — and every ledger row stays $0, never a real charge", async () => {
  await resetAll();
  const buyer = "buyer-override";

  for (let i = 0; i < 3; i++) {
    const { matchId } = await createMatch(buyer);
    await approveMatch(matchId, buyer);
  }

  const { matchId: fourthMatchId } = await createMatch(buyer);
  const blocked = await approveMatch(fourthMatchId, buyer);
  assert.equal(blocked.status, "locked");

  await entitlements.setManualOverride(buyer, true);
  const unlocked = await approveMatch(fourthMatchId, buyer);
  assert.equal(unlocked.status, "approved");

  const ledger = await db.withSchema((pool) =>
    pool.query(`SELECT amount_cents, billing_status FROM billing_ledger ORDER BY id`)
  );
  assert.equal(ledger.rows.length, 4, "one ledger row per approval, complimentary and overridden alike");
  assert.ok(
    ledger.rows.every((r) => r.amount_cents === 0),
    "no ledger row may ever carry a nonzero amount — a live charge must never be attempted"
  );
  assert.deepEqual(
    ledger.rows.map((r) => r.billing_status),
    ["complimentary", "complimentary", "complimentary", "plan_included"]
  );
});

test("passMatch marks a match passed, refuses a second decision, and rejects an unknown match id", async () => {
  await resetAll();
  const { matchId } = await createMatch("buyer-pass");

  assert.equal(await passMatch(matchId, "buyer-pass"), "passed");
  assert.equal(await passMatch(matchId, "buyer-pass"), "already_decided");
  assert.equal(await passMatch(999999, "buyer-pass"), "invalid");
});

test("passing a match never counts against the trial or writes a ledger entry", async () => {
  await resetAll();
  const buyer = "buyer-pass-2";
  const { matchId } = await createMatch(buyer);
  await passMatch(matchId, buyer);

  const ledger = await db.withSchema((pool) => pool.query(`SELECT * FROM billing_ledger`));
  assert.equal(ledger.rows.length, 0);

  // All 3 complimentary slots should still be available after a pass.
  for (let i = 0; i < 3; i++) {
    const { matchId: mid } = await createMatch(buyer);
    const outcome = await approveMatch(mid, buyer);
    assert.equal(outcome.status, "approved");
  }
});

/**
 * Real "actual counterparty connection" tests — both sides here are genuine chat-originated
 * WhatsApp users (unlike createMatch's API-mirrored seller above), so mutual confirmation
 * actually applies: neither side may learn the other's contact info until BOTH have approved.
 */
async function createChatVsChatMatch(
  buyerPhone: string,
  sellerPhone: string
): Promise<{ matchId: number }> {
  const n = ++counter;
  const ref = `MUTUAL${n}`;
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `fs-mutual-${n}`,
    senderIdentity: sellerPhone,
    text: `FS Rolex ${ref} $10,000`,
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `wtb-mutual-${n}`,
    senderIdentity: buyerPhone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return { matchId: matches.rows[0].id };
}

test('required: approving reveals the counterpart immediately, without waiting for the other side to also approve -- real reported ask: "the approved should release the number"', async () => {
  await resetAll();
  const { matchId } = await createChatVsChatMatch("buyer-mutual-1", "seller-mutual-1");

  const outcome = await approveMatch(matchId, "buyer-mutual-1");
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.counterpart?.phone, "seller-mutual-1", "the very first approver must see the counterpart's contact info right away");
});

test("required (privacy): a private WhatsApp user's own phone number is never shown as an 'identity' before approval — real reported bug, since contact_name falls back to the raw phone when no display name was ever captured", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "15551234567";
  const sellerPhone = "15557654321";
  const { matchId } = await createChatVsChatMatch(buyerPhone, sellerPhone);

  const potentialMatchCards = sent.map((s) => s.message);
  for (const card of potentialMatchCards) {
    assert.doesNotMatch(card, new RegExp(buyerPhone), "the very first match card must never leak a counterpart's raw phone number");
    assert.doesNotMatch(card, new RegExp(sellerPhone), "the very first match card must never leak a counterpart's raw phone number");
  }

  const outcome = await approveMatch(matchId, buyerPhone);
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.match?.identity, undefined, "no display name was ever captured, so the fallback (the raw phone) must not be surfaced as an identity");
});

test("required (privacy): a Telegram/SMS counterpart's raw identity (\"telegram:5703391972\") is never shown as an 'identity' before approval — the platform prefix's own letters defeated the digit-only check the WhatsApp case relies on", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerIdentity = "telegram:5703391972";
  const sellerPhone = "15557654321";
  const n = ++counter;
  const ref = `TGRAM${n}`;
  await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: `fs-tg-${n}`, senderIdentity: sellerPhone, text: `FS Rolex ${ref} $10,000` });
  const wtb = await ingestChatPosting({ platform: "telegram", chatId: "g1", messageId: `wtb-tg-${n}`, senderIdentity: buyerIdentity, text: `WTB Rolex ${ref} budget $12,000` });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  const matchId = matches.rows[0].id;

  for (const card of sent.map((s) => s.message)) {
    assert.doesNotMatch(card, /5703391972/, "the very first match card must never leak a counterpart's raw Telegram identity");
  }

  const outcome = await approveMatch(matchId, sellerPhone);
  assert.equal(outcome.status, "approved");
  assert.equal(outcome.match?.identity, undefined, "no display name was ever captured, so the raw \"telegram:...\" identity must not be surfaced as an identity");
});

test("each side's approval reveals the counterpart independently and synchronously, with no cross-side push needed for either", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const { matchId } = await createChatVsChatMatch("buyer-mutual-2", "seller-mutual-2");
  sent.length = 0; // ignore the "Match ID#" notifications from matching itself

  const first = await approveMatch(matchId, "buyer-mutual-2");
  assert.equal(first.status, "approved");
  assert.equal(first.counterpart!.phone, "seller-mutual-2", "the first approver is revealed the counterpart synchronously, without waiting for the other side");
  assert.equal(sent.length, 0, "the reveal is returned directly in the reply, not pushed as a separate message");

  const second = await approveMatch(matchId, "seller-mutual-2");
  assert.equal(second.status, "approved");
  assert.equal(second.counterpart!.phone, "buyer-mutual-2", "the second approver is revealed the counterpart synchronously too");
  assert.equal(sent.length, 0, "neither side's own approval push anything to the other -- each only ever reveals to itself");

  const matchRow = await db.withSchema((pool) => pool.query(`SELECT connected_at FROM matches WHERE id=$1`, [matchId]));
  assert.ok(matchRow.rows[0].connected_at, "the match records a connected status once both sides have independently approved");
});

test("required: getApprovedMatchesSummary shows the counterpart as soon as its own side approves, independently of the other side's decision", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getApprovedMatchesSummary } = require("./approvalUsage") as typeof import("./approvalUsage");

  const { matchId } = await createChatVsChatMatch("buyer-privacy-1", "seller-privacy-1");

  await approveMatch(matchId, "buyer-privacy-1");
  const buyerSummaryBefore = await getApprovedMatchesSummary("buyer-privacy-1");
  assert.equal(buyerSummaryBefore.length, 1, "the approval itself is recorded immediately");
  assert.equal(buyerSummaryBefore[0].counterpartPhone, "seller-privacy-1", "revealed as soon as this side approves, without waiting for the seller");
  assert.match(buyerSummaryBefore[0].listingDescription, /Rolex/, "the watch itself is never sensitive — safe to show immediately");

  await approveMatch(matchId, "seller-privacy-1");

  const sellerSummary = await getApprovedMatchesSummary("seller-privacy-1");
  assert.equal(sellerSummary[0].counterpartPhone, "buyer-privacy-1", "the seller's own approval reveals the buyer to the seller too, independently");
});

test("repeated clicks after mutual confirmation never re-send the introduction or re-reveal redundantly", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const { matchId } = await createChatVsChatMatch("buyer-mutual-3", "seller-mutual-3");
  await approveMatch(matchId, "buyer-mutual-3");
  await approveMatch(matchId, "seller-mutual-3");
  sent.length = 0;

  // Both sides click "approve" again after already being connected.
  const buyerAgain = await approveMatch(matchId, "buyer-mutual-3");
  const sellerAgain = await approveMatch(matchId, "seller-mutual-3");

  assert.equal(buyerAgain.status, "approved");
  assert.equal(sellerAgain.status, "approved");
  assert.equal(sent.length, 0, "no further introductions or pushes once both sides are already connected");
});

test("a locked (trial-exhausted) approval attempt never reveals or pushes anything", async (t) => {
  await resetAll();
  const sent: unknown[] = [];
  t.mock.method(whapiClient, "sendText", async () => {
    sent.push(true);
  });

  const buyer = "buyer-mutual-locked";
  for (let i = 0; i < 3; i++) {
    const { matchId } = await createMatch(buyer);
    await approveMatch(matchId, buyer);
  }
  sent.length = 0;

  const { matchId } = await createChatVsChatMatch(buyer, "seller-mutual-locked");
  sent.length = 0; // clear the "Match ID#" notifications createChatVsChatMatch itself sends

  const outcome = await approveMatch(matchId, buyer);
  assert.equal(outcome.status, "locked");
  assert.equal(outcome.counterpart, undefined);
  assert.equal(sent.length, 0, "a locked attempt must never reveal or push anything");
});

test("required: a buyer never receives more than maxMatchesPerListing match cards for the same WTB, even when far more candidates match — live-reported flood of near-unlimited 'Match ID#' notifications for one broad request", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "buyer-cap-1";
  for (let i = 0; i < 5; i++) {
    await mirrorApiFsPosting({
      id: `wf-cap-${i}`,
      item: "Rolex",
      brand: "Rolex",
      ref: `CAPREF${i}`,
      condition: "New",
      price: "$10,000",
      contactName: `seller-cap-${i}`,
      contactPhone: `seller-cap-${i}`,
      description: "",
    });
  }
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: "wtb-cap-1",
    senderIdentity: buyerPhone,
    text: "WTB Rolex budget $50,000", // no reference -- matches every Rolex FS listing above on brand alone
  });
  await runImmediateMatch(wtb.posting!);

  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  assert.equal(matches.rows.length, 5, "all 5 candidates must still be scored/recorded as matches");

  const toBuyer = sent.filter((s) => s.phone === buyerPhone);
  assert.equal(toBuyer.length, 3, "the buyer's inbox must be capped at maxMatchesPerListing (3), not flooded with every candidate");
});

test("required: a paying-member seller's match is never blocked by a buyer's cap, even after free-tier sellers already filled it", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "buyer-paying-seller-1";
  // Fill the buyer's default cap (3) with ordinary free-tier sellers first.
  for (let i = 0; i < 3; i++) {
    await mirrorApiFsPosting({ id: `wf-free-${i}`, item: "Rolex", brand: "Rolex", ref: `FREEREF${i}`, condition: "New", price: "$10,000", contactName: `seller-free-${i}`, contactPhone: `seller-free-${i}`, description: "" });
  }
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "wtb-paying-seller-1", senderIdentity: buyerPhone, text: "WTB Rolex budget $50,000" });
  await runImmediateMatch(wtb.posting!);
  assert.equal(sent.filter((s) => s.phone === buyerPhone).length, 3, "sanity check: the free-tier cap is already full");

  // A paying-plan seller matching the same WTB afterward must still reach the buyer.
  await entitlements.setPlan("seller-paying-1", "tier1");
  await mirrorApiFsPosting({ id: "wf-paying-1", item: "Rolex", brand: "Rolex", ref: "PAYINGREF1", condition: "New", price: "$10,000", contactName: "seller-paying-1", contactPhone: "seller-paying-1", description: "" });
  await runImmediateMatch((await db.withSchema((pool) => pool.query(`SELECT * FROM postings WHERE contact_phone='seller-paying-1'`))).rows[0]);

  assert.equal(sent.filter((s) => s.phone === buyerPhone).length, 4, "the paying seller's match must be delivered on top of the already-full free-tier cap, not blocked by it");
});

test("required: a paying-member seller's delivery doesn't consume a free-tier competitor's slot in the same cap", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "buyer-paying-seller-2";
  await entitlements.setPlan("seller-paying-2", "tier1");
  await mirrorApiFsPosting({ id: "wf-paying-2", item: "Rolex", brand: "Rolex", ref: "PAYINGREF2", condition: "New", price: "$10,000", contactName: "seller-paying-2", contactPhone: "seller-paying-2", description: "" });
  // Then fill the (still-default, since the buyer itself isn't paying) free-tier cap with 3 more.
  for (let i = 0; i < 3; i++) {
    await mirrorApiFsPosting({ id: `wf-free2-${i}`, item: "Rolex", brand: "Rolex", ref: `FREEREF2${i}`, condition: "New", price: "$10,000", contactName: `seller-free2-${i}`, contactPhone: `seller-free2-${i}`, description: "" });
  }
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "wtb-paying-seller-2", senderIdentity: buyerPhone, text: "WTB Rolex budget $50,000" });
  await runImmediateMatch(wtb.posting!);

  const toBuyer = sent.filter((s) => s.phone === buyerPhone);
  assert.equal(toBuyer.length, 4, "all 3 free-tier sellers PLUS the paying seller must be delivered -- the paying seller's slot is separate from, not carved out of, the free-tier cap");
});

test("required: a paying-member buyer gets a much higher cap on their own listing than the free-tier default", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "buyer-paying-3";
  await entitlements.setPlan(buyerPhone, "tier1");
  for (let i = 0; i < 5; i++) {
    await mirrorApiFsPosting({ id: `wf-paying3-${i}`, item: "Rolex", brand: "Rolex", ref: `PAYINGREF3${i}`, condition: "New", price: "$10,000", contactName: `seller-paying3-${i}`, contactPhone: `seller-paying3-${i}`, description: "" });
  }
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "wtb-paying-3", senderIdentity: buyerPhone, text: "WTB Rolex budget $50,000" });
  await runImmediateMatch(wtb.posting!);

  assert.equal(sent.filter((s) => s.phone === buyerPhone).length, 5, "a paying buyer must see well beyond the free-tier default cap of 3");
});

test("required: priority is live, not cached -- canceling a plan drops the account back to the default cap on the very next match", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => sent.push({ phone, message }));

  const buyerPhone = "buyer-lapsed-1";
  await entitlements.setPlan(buyerPhone, "tier1");
  await entitlements.cancelMembership(buyerPhone); // was a member, no longer is
  for (let i = 0; i < 5; i++) {
    await mirrorApiFsPosting({ id: `wf-lapsed-${i}`, item: "Rolex", brand: "Rolex", ref: `LAPSEDREF${i}`, condition: "New", price: "$10,000", contactName: `seller-lapsed-${i}`, contactPhone: `seller-lapsed-${i}`, description: "" });
  }
  const wtb = await ingestChatPosting({ platform: "whatsapp", chatId: "g1", messageId: "wtb-lapsed-1", senderIdentity: buyerPhone, text: "WTB Rolex budget $50,000" });
  await runImmediateMatch(wtb.posting!);

  assert.equal(sent.filter((s) => s.phone === buyerPhone).length, 3, "a lapsed membership must be treated as free-tier immediately, capped at the default (3), not grandfathered in at the paying cap");
});

/** Same shape as createMatch above, but with the brand held fixed by the caller — createMatch
 *  always uses "Rolex", so two calls for the same buyer would both fall back to the same
 *  broad "same brand" match against BOTH FS listings (chat-parsed free text never actually
 *  captures "REF1"/"REF2" as a real reference, so the exact-reference branch never engages);
 *  a different brand per call keeps the two matches genuinely isolated. */
async function createMatchWithBrand(buyerPhone: string, brand: string): Promise<{ matchId: number }> {
  const n = ++counter;
  const sellerPhone = `seller-${n}`;
  await mirrorApiFsPosting({
    id: `wf-${n}`, item: brand, brand, ref: `REF${n}`, condition: "New", price: "$10,000",
    contactName: sellerPhone, contactPhone: sellerPhone, description: "",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp", chatId: "g1", messageId: `wtb-${n}`, senderIdentity: buyerPhone,
    text: `WTB ${brand} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return { matchId: matches.rows[0].id };
}

test("getPendingMatchesForRecipient lists a user's own pending (delivered, undecided) matches, most recently presented first", async (t) => {
  await resetAll();
  t.mock.method(whapiClient, "sendText", async () => {});
  const buyerPhone = "buyer-pending-1";
  const { matchId: firstMatchId } = await createMatchWithBrand(buyerPhone, "Rolex");
  const { matchId: secondMatchId } = await createMatchWithBrand(buyerPhone, "Omega");

  const canonicalUserId = await identity.getOrCreateCanonicalUser("whatsapp", buyerPhone);
  const options = await notify.getPendingMatchesForRecipient(canonicalUserId);
  assert.deepEqual(options.map((o) => o.matchId), [secondMatchId, firstMatchId], "most recently presented first");
});

test("getPendingMatchesForRecipient excludes a match the user already decided on", async (t) => {
  await resetAll();
  t.mock.method(whapiClient, "sendText", async () => {});
  const buyerPhone = "buyer-pending-2";
  const { matchId } = await createMatch(buyerPhone);
  await passMatch(matchId, buyerPhone);

  const canonicalUserId = await identity.getOrCreateCanonicalUser("whatsapp", buyerPhone);
  assert.deepEqual(await notify.getPendingMatchesForRecipient(canonicalUserId), []);
});

test("getPendingMatchesForRecipient's sourceType filter restricts to matches where the RECIPIENT's own side was created that way", async (t) => {
  await resetAll();
  t.mock.method(whapiClient, "sendText", async () => {});
  const buyerPhone = "buyer-pending-3";
  // createMatch's WTB (buyer) side is chat-sourced, not 'direct'.
  await createMatch(buyerPhone);
  const canonicalUserId = await identity.getOrCreateCanonicalUser("whatsapp", buyerPhone);
  assert.deepEqual(
    await notify.getPendingMatchesForRecipient(canonicalUserId, { sourceType: "direct" }),
    [],
    "a chat-sourced posting must not pass a 'direct' filter"
  );
});

test("a delivery failure falls back to another linked channel ONLY when the recipient opted into fallback delivery", async (t) => {
  await resetAll();
  const buyerPhone = "buyer-fallback-1";
  const canonicalUserId = await identity.getOrCreateCanonicalUser("whatsapp", buyerPhone);
  await notificationPreferences.linkIdentity(canonicalUserId, "telegram", "telegram:fallback-1");
  await notificationPreferences.setPreferredChannel(canonicalUserId, "whatsapp");
  await notificationPreferences.setFallbackEnabled(canonicalUserId, true);

  t.mock.method(whapiClient, "sendText", async () => {
    throw new Error("simulated WhatsApp send failure");
  });
  const telegramSent: { identity: string; message: string }[] = [];
  t.mock.method(telegramClient, "sendText", async (recipient: string, message: string) => {
    telegramSent.push({ identity: recipient, message });
  });

  const { matchId } = await createMatch(buyerPhone);
  assert.equal(telegramSent.length, 1, "fell back to the Telegram identity after the WhatsApp send failed");
  assert.equal(telegramSent[0].identity, "telegram:fallback-1");

  const delivered = await db.withSchema((pool) => pool.query(`SELECT delivered_at FROM match_recipients WHERE match_id=$1`, [matchId]));
  assert.ok(delivered.rows[0].delivered_at, "recorded as delivered once the fallback actually succeeded");
});

test("a delivery failure is never retried on another channel when fallback delivery is off (the default)", async (t) => {
  await resetAll();
  const buyerPhone = "buyer-fallback-2";
  const canonicalUserId = await identity.getOrCreateCanonicalUser("whatsapp", buyerPhone);
  await notificationPreferences.linkIdentity(canonicalUserId, "telegram", "telegram:fallback-2");
  // fallback_enabled defaults to false -- deliberately not set here.

  t.mock.method(whapiClient, "sendText", async () => {
    throw new Error("simulated WhatsApp send failure");
  });
  const telegramSent: unknown[] = [];
  t.mock.method(telegramClient, "sendText", async () => {
    telegramSent.push(true);
  });

  const { matchId } = await createMatch(buyerPhone);
  assert.equal(telegramSent.length, 0, "never silently switches channels for a routine notification without the recipient's opt-in");

  const delivered = await db.withSchema((pool) => pool.query(`SELECT delivered_at FROM match_recipients WHERE match_id=$1`, [matchId]));
  assert.equal(delivered.rows.length, 0, "the claim is deleted (retryable) after a failed delivery, same as the pre-existing failure path");
});

test("formatPhoneForDisplay: a North American number (with or without a leading country code) reads as +1 (XXX) XXX-XXXX", () => {
  assert.equal(notify.formatPhoneForDisplay("12134492911"), "+1 (213) 449-2911", "11 digits, leading country code");
  assert.equal(notify.formatPhoneForDisplay("2134492911"), "+1 (213) 449-2911", "10 digits, no country code");
  assert.equal(notify.formatPhoneForDisplay("+1 (213) 449-2911"), "+1 (213) 449-2911", "already-formatted input is normalized the same way");
});

test("formatPhoneForDisplay: a non-North-American-shaped number is shown as a plain +<digits> rather than guessed at", () => {
  assert.equal(notify.formatPhoneForDisplay("442071838750"), "+442071838750");
});

test("formatPhoneForDisplay: a non-numeric identifier (e.g. an API-mirrored listing's internal contact id) is passed through unchanged rather than mangled", () => {
  assert.equal(notify.formatPhoneForDisplay("dealer-413"), "dealer-413");
});

test('required regression: formatMatchPresentation never lists the reference twice -- real reported bug: "Watch: rolex daytona 116500ln 116500LN", because the model field itself already carried the reference text', () => {
  const text = notify.formatMatchPresentation(781, "Seller/Buyer", {
    brand: "rolex",
    model: "daytona 116500ln",
    reference: "116500LN",
  }, "Approved Match");
  assert.equal((text.match(/116500LN/gi) ?? []).length, 1, "the reference must appear exactly once, however it's cased");
  assert.match(text, /Watch: rolex daytona 116500LN/i);
});

test("formatMatchPresentation leaves a model that does NOT already contain the reference untouched", () => {
  const text = notify.formatMatchPresentation(1, "Seller/Buyer", { brand: "Rolex", model: "Submariner", reference: "116610LV" });
  assert.match(text, /Watch: Rolex Submariner 116610LV/);
});

test("required: the counterpart's own free-text description shows as its own line, labeled and truncated", () => {
  const short = notify.formatMatchPresentation(1, "Seller", { brand: "Rolex", model: "Submariner", description: "Firm on price, can ship worldwide." });
  assert.match(short, /💬 In their words: Firm on price, can ship worldwide\./);

  const long = notify.formatMatchPresentation(2, "Seller", { brand: "Rolex", description: "x".repeat(200) });
  const line = long.split("\n").find((l) => l.startsWith("💬"))!;
  assert.ok(line.length < 200, "a long description must be truncated, not reprinted in full");
  assert.match(line, /…$/);
});
test("required: no description means no 💬 line at all", () => {
  const text = notify.formatMatchPresentation(1, "Seller", { brand: "Rolex", model: "Submariner" });
  assert.doesNotMatch(text, /💬/);
});

test("required: formatMatchMessage's reply instructions ask only for \"approve\" (not \"pass\") since ignoring already has the same effect, and point people to \"listings\" to close a request once they're done", () => {
  const self = { type: "WTB", brand: "Rolex", model: "Daytona", reference: "", dial: "", condition: "", price: null, currency: "USD", location: "", contact_name: "", contact_phone: "", source_type: "chat", original_text: "" } as any;
  const counterpart = { type: "FS", brand: "Rolex", model: "Daytona", reference: "116500LN", dial: "", condition: "", price: "35000", currency: "USD", location: "", contact_name: "", contact_phone: "", source_type: "api", original_text: "" } as any;
  const text = notify.formatMatchMessage(555, self, counterpart, ["Same brand: Rolex"], null);
  assert.match(text, /Reply "approve 555" to get their contact info\./);
  assert.doesNotMatch(text, /pass 555/, "pass is no longer asked for -- ignoring a match already has the same effect");
  assert.match(text, /Not for you\? No need to reply/);
  assert.match(text, /Reply "listings" to close that request/);
});

test("isRealDisplayName: a real name (with or without a business-y suffix) passes; a bare or platform-prefixed identity does not", () => {
  assert.equal(notify.isRealDisplayName("John Smith"), true);
  assert.equal(notify.isRealDisplayName("ABC Watches"), true);
  assert.equal(notify.isRealDisplayName("15551234567"), false);
  assert.equal(notify.isRealDisplayName("telegram:5703391972"), false);
  assert.equal(notify.isRealDisplayName("sms:15557654321"), false);
});
