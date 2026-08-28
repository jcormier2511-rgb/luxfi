import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import {
  mergeCanonicalUsers,
  resolveCanonicalUserForPlatformIdentity,
} from '../src/services/canonicalUser.service';
import { ingestApiPosting } from '../src/services/posting.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { approveMatch } from '../src/services/approval.service';
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

async function makeUser(platformUserId: string): Promise<string> {
  const identity = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId,
  });
  return identity.canonicalUserId;
}

async function makeApprovedDealFor(buyer: string): Promise<string> {
  idCounter += 1;
  const seller = await makeUser(`merge-seller-${idCounter}-${Date.now()}`);
  const { posting: fs } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: `merge-fs-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: seller,
    referenceNumber: '116500LN',
  });
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'WTB',
    externalListingId: `merge-wtb-${idCounter}-${Date.now()}`,
    ownerCanonicalUserId: buyer,
    referenceNumber: '116500LN',
  });
  await runMatchingForPosting(pool, wtb.id, true);
  const { rows } = await pool.query('SELECT id FROM matches WHERE fs_posting_id = $1 AND wtb_posting_id = $2', [
    fs.id,
    wtb.id,
  ]);
  return rows[0].id as string;
}

test('merging reassigns platform identities, postings, and tombstones the source account', async () => {
  const fromId = await makeUser('merge-phone-old');
  const toId = await makeUser('merge-phone-new');
  const { posting } = await ingestApiPosting(pool, {
    sourceType: 'api',
    platform: 'watchfacts',
    postingType: 'FS',
    externalListingId: 'merge-owned-posting',
    ownerCanonicalUserId: fromId,
  });

  await mergeCanonicalUsers(pool, fromId, toId);

  const { rows: userRows } = await pool.query('SELECT merged_into_id FROM canonical_users WHERE id = $1', [fromId]);
  expect(userRows[0].merged_into_id).toBe(toId);

  const { rows: postingRows } = await pool.query('SELECT canonical_user_id FROM postings WHERE id = $1', [posting.id]);
  expect(postingRows[0].canonical_user_id).toBe(toId);

  // Resolving the OLD platform identity now follows the merge to the target account.
  const resolved = await resolveCanonicalUserForPlatformIdentity(pool, {
    platform: 'whatsapp',
    platformUserId: 'merge-phone-old',
  });
  expect(resolved.canonicalUserId).toBe(toId);
});

test('merging never creates a second complimentary trial -- usage is recomputed, not summed', async () => {
  const fromId = await makeUser('merge-trial-old');
  const toId = await makeUser('merge-trial-new');

  // Two approvals on the "old" identity, one on the "new" identity, before they're linked.
  await approveMatch(pool, await makeApprovedDealFor(fromId), fromId);
  await approveMatch(pool, await makeApprovedDealFor(fromId), fromId);
  await approveMatch(pool, await makeApprovedDealFor(toId), toId);

  await mergeCanonicalUsers(pool, fromId, toId);

  const { rows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [toId]);
  expect(rows[0].trial_approvals_used).toBe(3); // exact count, not double-counted or reset
});

test('a duplicate approval on the same match from both sides survives the merge as exactly one approval', async () => {
  const fromId = await makeUser('merge-dup-old');
  const toId = await makeUser('merge-dup-new');

  const matchId = await makeApprovedDealFor(fromId);
  // Re-point the same match's WTB posting to `toId` and have them independently
  // "approve" it too, simulating two not-yet-linked identities both acting on
  // what turns out to be the same deal.
  await pool.query(
    `UPDATE postings SET canonical_user_id = $2 WHERE id = (SELECT wtb_posting_id FROM matches WHERE id = $1)`,
    [matchId, toId]
  );
  await approveMatch(pool, matchId, toId);

  await mergeCanonicalUsers(pool, fromId, toId);

  const { rows: approvalRows } = await pool.query('SELECT COUNT(*)::int AS c FROM approvals WHERE match_id = $1', [
    matchId,
  ]);
  expect(approvalRows[0].c).toBe(1); // no duplicate/constraint violation
  const { rows: userRows } = await pool.query('SELECT trial_approvals_used FROM canonical_users WHERE id = $1', [
    toId,
  ]);
  expect(userRows[0].trial_approvals_used).toBe(1);
});

test('membership_entitlements: the target keeps its own row; otherwise it adopts the source\'s', async () => {
  const fromWithEntitlement = await makeUser('merge-ent-source');
  const toWithoutEntitlement = await makeUser('merge-ent-target-empty');
  await setManualEntitlementOverride(pool, fromWithEntitlement, true, 'admin@luxfi.test', 'early access');

  await mergeCanonicalUsers(pool, fromWithEntitlement, toWithoutEntitlement);

  const { rows: adopted } = await pool.query(
    'SELECT manual_override_enabled FROM membership_entitlements WHERE canonical_user_id = $1',
    [toWithoutEntitlement]
  );
  expect(adopted[0].manual_override_enabled).toBe(true);

  // Second scenario: target already has its own row -- that one wins, source's is dropped.
  const fromWithEntitlement2 = await makeUser('merge-ent-source-2');
  const toWithOwnEntitlement = await makeUser('merge-ent-target-own');
  await setManualEntitlementOverride(pool, fromWithEntitlement2, true, 'admin@luxfi.test', 'should be discarded');
  await setManualEntitlementOverride(pool, toWithOwnEntitlement, false, 'admin@luxfi.test', 'target keeps this');

  await mergeCanonicalUsers(pool, fromWithEntitlement2, toWithOwnEntitlement);

  const { rows: kept } = await pool.query(
    'SELECT manual_override_enabled FROM membership_entitlements WHERE canonical_user_id = $1',
    [toWithOwnEntitlement]
  );
  expect(kept[0].manual_override_enabled).toBe(false);
  const { rows: orphaned } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM membership_entitlements WHERE canonical_user_id = $1',
    [fromWithEntitlement2]
  );
  expect(orphaned[0].c).toBe(0);
});

test('merging a user into itself is a safe no-op', async () => {
  const userId = await makeUser('merge-self');
  await expect(mergeCanonicalUsers(pool, userId, userId)).resolves.toBeUndefined();
  const { rows } = await pool.query('SELECT merged_into_id FROM canonical_users WHERE id = $1', [userId]);
  expect(rows[0].merged_into_id).toBeNull();
});
