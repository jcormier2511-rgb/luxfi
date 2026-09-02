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

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch, passMatch } = notify;

after(async () => {
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
  for (const expected of ["ABC Watches", "Rolex Daytona 116500LN", "Dial/Color: Black", "2023 • Full set • New", "$28,500", "Miami, USA", "Candidate ID: dealer-listing-413", "Source: https://example.com/listings/413", "Photo: https://example.com/photos/413.jpg"]) {
    assert.match(card!, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `card should include ${expected}`);
  }
  const matchId = Number(card!.match(/approve (\d+)/)?.[1]);
  assert.ok(Number.isInteger(matchId));
  const outcome = await approveMatch(matchId, "buyer-rich-card");
  assert.equal(outcome.status, "approved", "the exact delivered match remains actionable");
  assert.equal(outcome.match?.identity, "ABC Watches");
  assert.equal((await approveMatch(987654321, "buyer-rich-card")).status, "invalid", "unknown/expired IDs fail safely");
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

test("the first side to approve a real chat-vs-chat match gets pending_confirmation, revealing nothing yet", async () => {
  await resetAll();
  const { matchId } = await createChatVsChatMatch("buyer-mutual-1", "seller-mutual-1");

  const outcome = await approveMatch(matchId, "buyer-mutual-1");
  assert.equal(outcome.status, "pending_confirmation");
  assert.equal(outcome.counterpart, undefined, "must not reveal the counterpart's contact info before they've also confirmed");
});

test("once both sides approve, the second approver is revealed immediately and the first is sent a one-time introduction", async (t) => {
  await resetAll();
  const sent: { phone: string; message: string }[] = [];
  t.mock.method(whapiClient, "sendText", async (phone: string, message: string) => {
    sent.push({ phone, message });
  });

  const { matchId } = await createChatVsChatMatch("buyer-mutual-2", "seller-mutual-2");
  sent.length = 0; // ignore the "Potential Match" notifications from matching itself

  const first = await approveMatch(matchId, "buyer-mutual-2");
  assert.equal(first.status, "pending_confirmation");
  assert.equal(sent.length, 0, "no introduction goes out while only one side has confirmed");

  const second = await approveMatch(matchId, "seller-mutual-2");
  assert.equal(second.status, "approved");
  assert.equal(second.counterpart!.phone, "buyer-mutual-2", "the completing approver is revealed the counterpart synchronously");

  assert.equal(sent.length, 1, "exactly one introduction must be pushed — to the side that was left waiting");
  assert.equal(sent[0].phone, "buyer-mutual-2");
  assert.match(sent[0].message, /seller-mutual-2/, "the introduction must contain the counterpart's contact info");
  assert.match(sent[0].message, /escrow and inspection partners/i, "the one-time introduction push must also suggest escrow/inspection");

  const matchRow = await db.withSchema((pool) => pool.query(`SELECT connected_at FROM matches WHERE id=$1`, [matchId]));
  assert.ok(matchRow.rows[0].connected_at, "the match must record a connected status once both sides have confirmed");
});

test("required (privacy): getApprovedMatchesSummary never shows a counterpart before mutual confirmation, then shows it correctly for both sides once revealed", async (t) => {
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
  assert.equal(buyerSummaryBefore[0].counterpartName, null, "must not reveal the counterpart before the seller has also confirmed");
  assert.equal(buyerSummaryBefore[0].counterpartPhone, null);
  assert.match(buyerSummaryBefore[0].listingDescription, /Rolex/, "the watch itself is never sensitive — safe to show immediately");

  await approveMatch(matchId, "seller-privacy-1");

  const buyerSummaryAfter = await getApprovedMatchesSummary("buyer-privacy-1");
  assert.equal(buyerSummaryAfter[0].counterpartPhone, "seller-privacy-1", "now safe to reveal — the seller has also confirmed");

  const sellerSummary = await getApprovedMatchesSummary("seller-privacy-1");
  assert.equal(sellerSummary[0].counterpartPhone, "buyer-privacy-1", "the completing approver's own summary is revealed immediately too");
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
  sent.length = 0; // clear the "Potential Match" notifications createChatVsChatMatch itself sends

  const outcome = await approveMatch(matchId, buyer);
  assert.equal(outcome.status, "locked");
  assert.equal(outcome.counterpart, undefined);
  assert.equal(sent.length, 0, "a locked attempt must never reveal or push anything");
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
