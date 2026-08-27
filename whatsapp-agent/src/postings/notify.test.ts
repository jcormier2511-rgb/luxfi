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

const { ingestChatPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch, passMatch } = notify;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
});

let counter = 0;
/** Creates one fresh FS/WTB exact-reference match and returns its matchId + the two phones. */
async function createMatch(buyerPhone: string, sellerPhone?: string): Promise<{ matchId: number; sellerPhone: string }> {
  const n = ++counter;
  const seller = sellerPhone ?? `seller-${n}`;
  const ref = `REF${n}`;
  await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `fs-${n}`,
    senderIdentity: seller,
    text: `FS Rolex ${ref} $10,000`,
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
  return { matchId: matches.rows[0].id, sellerPhone: seller };
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
  const { matchId } = await createMatch("buyer-1");
  await approveMatch(matchId, "buyer-1");
  const again = await approveMatch(matchId, "buyer-1");
  assert.equal(again.status, "already_approved");

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
