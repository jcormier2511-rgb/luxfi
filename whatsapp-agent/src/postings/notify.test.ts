import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";

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

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch, passMatch } = notify;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
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
    ["complimentary", "complimentary", "complimentary", "admin_override_pending_billing"]
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

  const matchRow = await db.withSchema((pool) => pool.query(`SELECT connected_at FROM matches WHERE id=$1`, [matchId]));
  assert.ok(matchRow.rows[0].connected_at, "the match must record a connected status once both sides have confirmed");
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
