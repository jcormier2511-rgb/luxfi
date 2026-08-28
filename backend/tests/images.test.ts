import { Pool } from 'pg';
import { getTestPool, truncateAll, closeTestPool } from './testDb';
import { ingestApiPosting } from '../src/services/posting.service';
import { resolveCanonicalUserForPlatformIdentity } from '../src/services/canonicalUser.service';
import { addPostingImage, getPrimaryImage, tryAddPostingImage, InvalidImageError } from '../src/services/image.service';
import { runMatchingForPosting } from '../src/services/matching.service';
import { setMessagingAdapter, StubMessagingAdapter } from '../src/adapters/messaging.adapter';

let pool: Pool;
let idCounter = 0;
let stub: StubMessagingAdapter;

beforeAll(async () => {
  pool = await getTestPool();
});

beforeEach(() => {
  stub = new StubMessagingAdapter();
  setMessagingAdapter(stub);
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

async function makeFs(ownerId: string) {
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
  });
}

async function makeWtb(ownerId: string) {
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
  });
}

test('30. API and chat images attach to the correct posting', async () => {
  const seller = await makeUser();
  const { posting: fsA } = await makeFs(seller);
  const { posting: fsB } = await makeFs(seller);

  await addPostingImage(pool, {
    postingId: fsA.id,
    sourceUrl: 'https://cdn.example.com/a.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1000,
    contentHash: 'hash-a',
  });
  await addPostingImage(pool, {
    postingId: fsB.id,
    sourceUrl: 'https://cdn.example.com/b.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1000,
    contentHash: 'hash-b',
  });

  const { rows: aImages } = await pool.query('SELECT content_hash FROM posting_images WHERE posting_id = $1', [
    fsA.id,
  ]);
  const { rows: bImages } = await pool.query('SELECT content_hash FROM posting_images WHERE posting_id = $1', [
    fsB.id,
  ]);
  expect(aImages.map((r) => r.content_hash)).toEqual(['hash-a']);
  expect(bImages.map((r) => r.content_hash)).toEqual(['hash-b']);
});

test('31. the designated primary image appears in the Potential Match notification', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await addPostingImage(pool, {
    postingId: fs.id,
    sourceUrl: 'https://cdn.example.com/primary.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1000,
    contentHash: 'hash-primary',
    isPrimary: true,
  });
  await runMatchingForPosting(pool, fs.id, true);

  const { posting: wtb } = await makeWtb(buyer);
  await runMatchingForPosting(pool, wtb.id, true);

  const messageToBuyer = stub.sent.find((m) => m.recipientCanonicalUserId === buyer);
  expect(messageToBuyer?.imageUrl).toBe('https://cdn.example.com/primary.jpg');
});

test('32. duplicate media is stored only once', async () => {
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller);
  const input = {
    postingId: fs.id,
    sourceUrl: 'https://cdn.example.com/dup.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1000,
    contentHash: 'hash-dup',
  };
  await addPostingImage(pool, input);
  await addPostingImage(pool, input);
  await addPostingImage(pool, input);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM posting_images WHERE posting_id = $1', [fs.id]);
  expect(rows[0].c).toBe(1);
});

test('33. expired source URLs do not break previously retained images', async () => {
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await addPostingImage(pool, {
    postingId: fs.id,
    storageKey: 'durable/hash-retained.jpg',
    mimeType: 'image/jpeg',
    fileSize: 1000,
    contentHash: 'hash-retained',
    isPrimary: true,
  });
  const primary = await getPrimaryImage(pool, fs.id);
  expect(primary?.storageKey).toBe('durable/hash-retained.jpg');
});

test('34. listings without images match and notify normally', async () => {
  const seller = await makeUser();
  const buyer = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await runMatchingForPosting(pool, fs.id, true);
  const { posting: wtb } = await makeWtb(buyer);
  const result = await runMatchingForPosting(pool, wtb.id, true);
  expect(result.matchCount).toBe(1);
  expect(stub.sent.length).toBeGreaterThan(0);
});

test('35. a failed image operation does not fail posting ingestion or inventory synchronization', async () => {
  const seller = await makeUser();
  const { posting: fs } = await makeFs(seller);
  await expect(
    addPostingImage(pool, {
      postingId: fs.id,
      sourceUrl: 'not-a-valid-url',
      mimeType: 'image/jpeg',
      fileSize: 1000,
      contentHash: 'hash-bad',
    })
  ).rejects.toBeInstanceOf(InvalidImageError);

  // The best-effort wrapper used during ingestion must swallow the same failure.
  await expect(
    tryAddPostingImage(pool, {
      postingId: fs.id,
      sourceUrl: 'not-a-valid-url',
      mimeType: 'image/jpeg',
      fileSize: 1000,
      contentHash: 'hash-bad',
    })
  ).resolves.toBeUndefined();

  const { rows } = await pool.query('SELECT status FROM postings WHERE id = $1', [fs.id]);
  expect(rows[0].status).toBe('active');
});
