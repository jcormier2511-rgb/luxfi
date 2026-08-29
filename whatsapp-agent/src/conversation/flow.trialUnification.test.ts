import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Before postings/approvalUsage.ts existed, the on-demand (v3) search flow tracked its own
// trial counter (a per-phone JSON field) completely separately from the automatic-matching
// (v4) flow's canonical_users.total_approved_count — meaning a canonical account could get 3
// complimentary approvals through EACH system, 6 total. This file proves the fix: both flows
// now read and increment the SAME Postgres row for the same phone, so the trial is exhausted
// exactly once, no matter which system the approvals came through.
const tmpPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), "luxfi-flow-trialunify-test-"));
process.env.PERSIST_DIR = tmpPersistDir;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.WEBHOOK_TOKEN = "test";
process.env.TRIAL_MAX_APPROVED_MATCHES = "3";
process.env.ENABLE_V4_POSTINGS = "true";
process.env.V4_ALLOWED_CHAT_IDS = "*";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inventoryDb = require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const postingsDb = require("../postings/db") as typeof import("../postings/db");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entitlements = require("../billing/entitlementStore") as typeof import("../billing/entitlementStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require("../postings/postingsStore") as typeof import("../postings/postingsStore");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const matching = require("../postings/matching") as typeof import("../postings/matching");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const notify = require("../postings/notify") as typeof import("../postings/notify");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleIncomingMessage } = require("./flow") as typeof import("./flow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resetState } = require("./stateStore") as typeof import("./stateStore");

const { ingestChatPosting, mirrorApiFsPosting } = store;
const { runImmediateMatch } = matching;
const { approveMatch } = notify;

after(async () => {
  await inventoryDb._closePoolForTests();
  await postingsDb._closePoolForTests();
  await entitlements._closePoolForTests();
  fs.rmSync(tmpPersistDir, { recursive: true, force: true });
});

function fsRow(id: string): Parameters<typeof inventoryDb.upsertListings>[0][number] {
  return {
    id,
    type: "FS",
    category: "watches",
    item: `Rolex Daytona ${id}`,
    brand: "Rolex",
    ref: "116500LN",
    condition: "Used",
    price: "18500",
    location: "",
    contactName: `Seller ${id}`,
    contactPhone: "10000000000",
    rating: "",
    description: `Rolex Daytona ${id}`,
  };
}

/** One v3 on-demand search + approve #1 for `phone`. */
async function approveViaV3(phone: string, firstSearch: boolean): Promise<string[]> {
  const collected: string[] = [];
  const push = (r: { messages: string[] }) => collected.push(...r.messages);
  if (firstSearch) push(await handleIncomingMessage(phone, "hi"));
  push(await handleIncomingMessage(phone, "buy: Rolex Daytona"));
  if (firstSearch) {
    push(await handleIncomingMessage(phone, "any"));
    push(await handleIncomingMessage(phone, "any"));
    push(await handleIncomingMessage(phone, "any"));
    push(await handleIncomingMessage(phone, "any"));
  }
  push(await handleIncomingMessage(phone, "approve 1"));
  return collected;
}

let v4Counter = 0;
/** One v4 automatic-matching approval for `phone` — a fresh WTB matched against a WatchFacts-
 *  API-mirrored FS listing (no WhatsApp identity on the other side, so approving reveals
 *  immediately — same pattern as notify.test.ts/approvalUsage.test.ts's createMatch). */
async function approveViaV4(phone: string): Promise<import("../postings/notify").ApprovalOutcome> {
  const n = ++v4Counter;
  const ref = `TU${n}`;
  await mirrorApiFsPosting({
    id: `wf-tu-${n}`,
    item: "Rolex",
    brand: "Rolex",
    ref,
    condition: "New",
    price: "$10,000",
    contactName: `seller-tu-${n}`,
    contactPhone: `seller-tu-${n}`,
    description: "",
  });
  const wtb = await ingestChatPosting({
    platform: "whatsapp",
    chatId: "g1",
    messageId: `wtb-tu-${n}`,
    senderIdentity: phone,
    text: `WTB Rolex ${ref} budget $12,000`,
  });
  await runImmediateMatch(wtb.posting!);
  const matches = await postingsDb.withSchema((pool) => pool.query(`SELECT id FROM matches WHERE wtb_posting_id=$1`, [wtb.posting!.id]));
  return approveMatch(matches.rows[0].id, phone);
}

test("required: the 3-approval complimentary trial is shared between the v3 on-demand flow and the v4 automatic-matching flow — it cannot be exhausted twice", async () => {
  await inventoryDb._resetDbForTests();
  await postingsDb._resetDbForTests();
  await entitlements._resetDbForTests();
  const phone = "19998880001";
  resetState(phone);
  v4Counter = 0;

  await inventoryDb.upsertListings([fsRow("tu-1"), fsRow("tu-2")], new Date().toISOString());

  // 1st and 2nd complimentary approvals via v3's on-demand search flow.
  const first = await approveViaV3(phone, true);
  assert.ok(first.some((m) => /Approved #1/.test(m)), "1st approval (v3) should succeed");
  const second = await approveViaV3(phone, false);
  assert.ok(second.some((m) => /Approved #1/.test(m)), "2nd approval (v3) should succeed");

  // 3rd complimentary approval via v4's automatic-matching flow, SAME phone — this must be
  // recognized as the account's 3rd (and last free) approval, not its own separate 1st.
  const third = await approveViaV4(phone);
  assert.equal(third.status, "approved", "3rd approval (v4), on the same account, should still be complimentary");

  // 4th attempt, via v4, must be locked — no plan assigned, and the account's shared trial is
  // now exhausted (2 from v3 + 1 from v4 = 3, the full allowance).
  const fourthViaV4 = await approveViaV4(phone);
  assert.equal(fourthViaV4.status, "locked");
  assert.equal(fourthViaV4.lockReason, "no_plan");

  // 4th attempt via v3 must ALSO see the account as locked — proving the two flows share one
  // counter rather than v3 believing it still has its own fresh allowance.
  const fourthViaV3 = await approveViaV3(phone, false);
  assert.ok(!fourthViaV3.some((m) => /Approved #1/.test(m)), "v3 must also see the trial as exhausted");
  assert.ok(fourthViaV3.some((m) => /Fi member/i.test(m)), "v3 should show the no-plan decline message");

  const canonicalUsers = await postingsDb.withSchema((pool) => pool.query(`SELECT total_approved_count FROM canonical_users`));
  assert.equal(canonicalUsers.rows.length, 1, "v3 and v4 approvals for the same phone must resolve to exactly ONE canonical account");
  assert.equal(
    canonicalUsers.rows[0].total_approved_count,
    3,
    "exactly 3 complimentary approvals total across both systems, never 3 per system"
  );

  // Assigning a plan unlocks further approvals for BOTH flows, from the one shared counter.
  await entitlements.setPlan(phone, "tier1");
  const fifthViaV4 = await approveViaV4(phone);
  assert.equal(fifthViaV4.status, "approved", "a tier1 plan should unlock the next approval, made through either flow");
});
