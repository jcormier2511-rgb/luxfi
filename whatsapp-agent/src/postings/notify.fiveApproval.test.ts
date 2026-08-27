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
const ingestModule = require("./ingest") as typeof import("./ingest");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("./notify") as typeof import("./notify");

const { ingestChatPosting, getPosting } = store;
const { ingestApiFsSync } = ingestModule;
const { approveMatch, passMatch } = notify;

after(async () => {
  await db._closePoolForTests();
  await entitlements._closePoolForTests();
});

async function resetAll(): Promise<void> {
  await db._resetDbForTests();
  await entitlements._resetDbForTests();
}

function fsListing(id: string, ref: string) {
  return {
    id,
    item: "Rolex Daytona",
    brand: "Rolex",
    ref,
    condition: "New",
    price: "$10,000",
    contactName: `dealer-${id}`,
    contactPhone: `dealer-${id}`,
    description: "",
  };
}

/**
 * Builds ONE chat WTB posting and matches it against `count` distinct API-mirrored FS
 * listings sharing its reference — via ingestApiFsSync (mirror + reverse-match), the same
 * path a real WatchFacts sync uses — so every resulting match shares the SAME wtb_posting_id,
 * which is what the 5-approved-match cap is actually keyed on (postings.approved_match_count).
 */
async function buildWtbWithMatches(buyerPhone: string, count: number, ref: string): Promise<{ wtbPostingId: number; matchIds: number[] }> {
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `wtb-5cap-${buyerPhone}`,
    senderIdentity: buyerPhone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  for (let i = 0; i < count; i++) {
    await ingestApiFsSync([fsListing(`wf-5cap-${buyerPhone}-${i}`, ref)]);
  }
  const matches = await db.withSchema((pool) =>
    pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1 ORDER BY id`, [wtb.posting!.id])
  );
  return { wtbPostingId: wtb.posting!.id, matchIds: matches.rows.map((r) => r.id) };
}

test("five-approval closure: creates 5 unique matches, approves all 5 (override after 3), closes the posting exactly on the 5th", async () => {
  await resetAll();
  const buyer = "buyer-5cap-1";
  const { wtbPostingId, matchIds } = await buildWtbWithMatches(buyer, 5, "5CAP1");
  assert.equal(matchIds.length, 5, "setup sanity: 5 distinct matches must exist before any approvals");

  for (let i = 0; i < 3; i++) {
    const outcome = await approveMatch(matchIds[i], buyer);
    assert.equal(outcome.status, "approved", `complimentary approval #${i + 1} should succeed`);
  }

  // 4th needs the admin override — never a live charge, same as the existing entitlement tests.
  const fourthBlocked = await approveMatch(matchIds[3], buyer);
  assert.equal(fourthBlocked.status, "locked", "4th approval must be blocked before the override is granted");
  await entitlements.setManualOverride(buyer, true);

  const fourth = await approveMatch(matchIds[3], buyer);
  assert.equal(fourth.status, "approved");
  let posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 4);
  assert.equal(posting!.status, "active", "must not close before the 5th approval");

  const fifth = await approveMatch(matchIds[4], buyer);
  assert.equal(fifth.status, "approved");
  posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5);
  assert.equal(posting!.status, "completed_match_limit", "must close exactly on the 5th approval, not before or after");
});

test("five-approval closure: surfaced-but-passed matches never increment the count", async () => {
  await resetAll();
  const buyer = "buyer-5cap-2";
  const { wtbPostingId, matchIds } = await buildWtbWithMatches(buyer, 6, "5CAP2");
  await entitlements.setManualOverride(buyer, true); // avoid the trial lock getting in the way of this test's focus

  for (let i = 0; i < 5; i++) {
    const outcome = await approveMatch(matchIds[i], buyer);
    assert.equal(outcome.status, "approved");
  }
  let posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5);
  assert.equal(posting!.status, "completed_match_limit");

  // The 6th match exists (created before closure) but was never approved — passing it must
  // not move the count or reopen/otherwise affect the now-closed posting.
  const passResult = await passMatch(matchIds[5], buyer);
  assert.equal(passResult, "passed");

  posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5, "passing a surfaced match must never increment the approved count");
  assert.equal(posting!.status, "completed_match_limit", "passing must never reopen a closed posting");
});

test("five-approval closure: a closed posting cannot approve a 6th match, even a pre-existing one, and cannot create a new one either", async () => {
  await resetAll();
  const buyer = "buyer-5cap-3";
  const { wtbPostingId, matchIds } = await buildWtbWithMatches(buyer, 6, "5CAP3");
  await entitlements.setManualOverride(buyer, true);

  for (let i = 0; i < 5; i++) {
    await approveMatch(matchIds[i], buyer);
  }
  const canonicalUsers = await db.withSchema((pool) => pool.query(`SELECT total_approved_count FROM canonical_users`));
  assert.equal(canonicalUsers.rows[0].total_approved_count, 5);

  // Cannot approve the 6th, pre-existing match once the posting has closed.
  const sixth = await approveMatch(matchIds[5], buyer);
  assert.equal(sixth.status, "posting_closed");

  const posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5, "a blocked 6th approval must never increment the posting's count");

  const canonicalUsersAfter = await db.withSchema((pool) => pool.query(`SELECT total_approved_count FROM canonical_users`));
  assert.equal(canonicalUsersAfter.rows[0].total_approved_count, 5, "a blocked 6th approval must never consume another trial/override slot");

  const approvalsForSixth = await db.withSchema((pool) =>
    pool.query(`SELECT * FROM approvals WHERE match_id=$1`, [matchIds[5]])
  );
  assert.equal(approvalsForSixth.rows.length, 0, "a blocked attempt must never insert an approval row");

  // Cannot create a brand-new 7th match against the now-closed posting either.
  await ingestApiFsSync([fsListing(`wf-5cap-${buyer}-new`, "5CAP3")]);
  const allMatches = await db.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtbPostingId]));
  assert.equal(allMatches.rows.length, 6, "a closed posting must never gain a new match either");
});

test("five-approval closure: duplicate approval clicks on an already-approved match never increment the count further", async () => {
  await resetAll();
  const buyer = "buyer-5cap-4";
  const { wtbPostingId, matchIds } = await buildWtbWithMatches(buyer, 5, "5CAP4");
  await entitlements.setManualOverride(buyer, true);

  for (const matchId of matchIds) {
    await approveMatch(matchId, buyer);
  }
  let posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5);
  assert.equal(posting!.status, "completed_match_limit");

  // Re-click "approve" on a match that's already approved, after the posting has closed.
  const duplicate = await approveMatch(matchIds[2], buyer);
  assert.equal(duplicate.status, "approved", "an already-approved match still reports approved on a repeat click");

  posting = await getPosting(wtbPostingId);
  assert.equal(posting!.approved_match_count, 5, "a duplicate click must never increment the count past its true value");

  const approvalsForThatMatch = await db.withSchema((pool) =>
    pool.query(`SELECT * FROM approvals WHERE match_id=$1`, [matchIds[2]])
  );
  assert.equal(approvalsForThatMatch.rows.length, 1, "a duplicate click must never insert a second approval row");
});
