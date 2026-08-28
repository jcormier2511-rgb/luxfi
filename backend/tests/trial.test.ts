import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { approveMatch, passMatch, confirmCounterparty, getRevealedContact } from '../src/services/approval.service';
import { setManualEntitlementOverride } from '../src/services/entitlement.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

let pool: Pool;
let idCounter = 0;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(() => {
  setMessagingAdapter(new StubMessagingAdapter());
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

async function makeUser(): Promise<string> {
  idCounter += 1;
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: `user-${idCounter}-${Date.now()}`,
  });
  return identity.canonicalUserId;
}

async function makeFs(ownerId: string, overrides: Record<string, unknown> = {}) {
  idCounter += 1;
  return ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `fs-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: ownerId,
    referenceNumber: '116500LN',
    askingPrice: 18500,
    currency: 'USD',
    ...overrides,
  });
}

async function makeWtb(ownerId: string, overrides: Record<string, unknown> = {}) {
  idCounter += 1;
  return ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: ownerId,
    referenceNumber: '116500LN',
    maxBid: 20000,
    currency: 'USD',
    ...overrides,
  });
}

/** Creates a fresh match owned on the WTB side by `buyer`, matched against a new seller/FS. */
async function newMatchForBuyer(buyer: string): Promise<string> {
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  return rows[0].id;
}

test('23. three surfaced-but-unapproved matches consume no trial usage', async () => {
  const buyer = await makeUser();
  await newMatchForBuyer(buyer);
  await newMatchForBuyer(buyer);
  await newMatchForBuyer(buyer);

  const { rows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [buyer]);
  expect(rows[0].trial_approvals_used).toBe(0);
});

test('24. the first three account-level approvals create exactly three $0 ledger entries and no processor charge', async () => {
  const buyer = await makeUser();
  for (let i = 0; i < 3; i += 1) {
    const matchId = await newMatchForBuyer(buyer);
    const outcome = await approveMatch(pool, matchId, buyer);
    expect(outcome).toEqual({ status: 'approved', duplicate: false, isComplimentary: true });
  }

  const { rows } = await pool.query(
    `SELECT entry_type, amount, status FROM billing_ledger WHERE canonical_user_id = $1 ORDER BY created_at`,
    [buyer]
  );
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.entry_type).toBe('complimentary_approval');
    expect(Number(row.amount)).toBe(0);
    expect(row.status).toBe('recorded');
  }
  const chargedRows = await pool.query("SELECT 1 FROM billing_ledger WHERE status = 'charged'");
  expect(chargedRows.rows.length).toBe(0);
});

test('25. a new posting, group, or monitor does not restart the trial', async () => {
  const buyer = await makeUser();
  for (let i = 0; i < 3; i += 1) {
    const matchId = await newMatchForBuyer(buyer);
    await approveMatch(pool, matchId, buyer);
  }
  // Create more postings/monitors for the same account after the trial is used up.
  await makeWtb(buyer);
  await makeWtb(buyer);

  const { rows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [buyer]);
  expect(rows[0].trial_approvals_used).toBe(3);
});

test('26. approval number four follows the correct membership and billing rules', async () => {
  const buyer = await makeUser();
  for (let i = 0; i < 3; i += 1) {
    const matchId = await newMatchForBuyer(buyer);
    await approveMatch(pool, matchId, buyer);
  }

  const fourthMatchId = await newMatchForBuyer(buyer);
  const locked = await approveMatch(pool, fourthMatchId, buyer);
  expect(locked).toEqual({ status: 'locked', reason: 'locked_pending_admin_override' });

  await setManualEntitlementOverride(pool, buyer, true, 'admin@luxfi.test', 'early access');
  const unlocked = await approveMatch(pool, fourthMatchId, buyer);
  expect(unlocked.status).toBe('approved');
  if (unlocked.status === 'approved') {
    expect(unlocked.isComplimentary).toBe(false);
  }

  const ledger = await pool.query(
    "SELECT status, amount FROM billing_ledger WHERE canonical_user_id = $1 AND entry_type = 'paid_approval'",
    [buyer]
  );
  expect(ledger.rows.length).toBe(1);
  expect(ledger.rows[0].status).toBe('pending_billing'); // never a live charge
  expect(Number(ledger.rows[0].amount)).toBe(2);
});

test('27. repeated approval clicks never create duplicate trial usage, posting counts, ledger entries, or charges', async () => {
  const buyer = await makeUser();
  const matchId = await newMatchForBuyer(buyer);

  await approveMatch(pool, matchId, buyer);
  const second = await approveMatch(pool, matchId, buyer);
  const third = await approveMatch(pool, matchId, buyer);
  expect(second.status === 'approved' && second.duplicate).toBe(true);
  expect(third.status === 'approved' && third.duplicate).toBe(true);

  const { rows: userRows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [
    buyer,
  ]);
  expect(userRows[0].trial_approvals_used).toBe(1);

  const { rows: ledgerRows } = await pool.query('SELECT COUNT(*)::int AS c FROM billing_ledger WHERE canonical_user_id = $1', [
    buyer,
  ]);
  expect(ledgerRows[0].c).toBe(1);

  const { rows: approvalRows } = await pool.query('SELECT COUNT(*)::int AS c FROM approvals WHERE match_id = $1', [
    matchId,
  ]);
  expect(approvalRows[0].c).toBe(1);
});

test('28. counterparty confirmation does not consume trial usage or create a charge', async () => {
  const buyer = await makeUser();
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller, { contactMethods: [{ type: 'whatsapp', value: '+1', authorizedForSharing: false }] });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  const matchId = rows[0].id;

  await confirmCounterparty(pool, matchId, seller, true);

  const { rows: userRows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [
    seller,
  ]);
  expect(userRows[0].trial_approvals_used).toBe(0);
  const { rows: ledgerRows } = await pool.query('SELECT COUNT(*)::int AS c FROM billing_ledger WHERE canonical_user_id = $1', [
    seller,
  ]);
  expect(ledgerRows[0].c).toBe(0);
});

test('29. protected contact information is not revealed before the required approval/confirmation state', async () => {
  const buyer = await makeUser();
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller, {
    contactMethods: [{ type: 'whatsapp', value: '+15551234567', authorizedForSharing: false }],
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  const matchId = rows[0].id;

  expect(await getRevealedContact(pool, matchId, buyer)).toBeNull();

  await approveMatch(pool, matchId, buyer);
  // Buyer approved, but seller's contact isn't authorized and hasn't been confirmed yet.
  expect(await getRevealedContact(pool, matchId, buyer)).toBeNull();

  await confirmCounterparty(pool, matchId, seller, true);
  const revealed = await getRevealedContact(pool, matchId, buyer);
  expect(revealed).not.toBeNull();
  expect(revealed?.[0].value).toBe('+15551234567');
});

test('passing a match consumes no trial usage', async () => {
  const buyer = await makeUser();
  const matchId = await newMatchForBuyer(buyer);
  await passMatch(pool, matchId, buyer);
  const { rows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [buyer]);
  expect(rows[0].trial_approvals_used).toBe(0);
});
