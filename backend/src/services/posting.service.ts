import { Pool, PoolClient } from 'pg';
import {
  ApiPostingInput,
  ChatPostingInput,
  ContactMethod,
  DEFAULT_MONITOR_LIFETIME_DAYS,
  Posting,
  PostingStatus,
} from '../types/domain';
import { resolveCanonicalUserForPlatformIdentity } from './canonicalUser.service';

export interface IngestResult {
  posting: Posting;
  created: boolean;
  materiallyChanged: boolean;
}

const MATERIAL_FIELDS: (keyof Posting)[] = [
  'referenceNumber',
  'brand',
  'model',
  'dial',
  'material',
  'year',
  'condition',
  'boxPapers',
  'askingPrice',
  'maxBid',
  'currency',
  'location',
  'country',
  'status',
  'originalDescription',
];

function rowToPosting(row: Record<string, unknown>): Posting {
  return {
    id: row.id as string,
    canonicalUserId: row.canonical_user_id as string,
    sourcePlatform: row.source_platform as string,
    sourceType: row.source_type as Posting['sourceType'],
    sourceChatId: (row.source_chat_id as string) ?? null,
    sourceMessageId: (row.source_message_id as string) ?? null,
    externalListingId: (row.external_listing_id as string) ?? null,
    postingType: row.posting_type as Posting['postingType'],
    originalMessage: (row.original_message as string) ?? null,
    originalDescription: (row.original_description as string) ?? null,
    brand: (row.brand as string) ?? null,
    model: (row.model as string) ?? null,
    referenceNumber: (row.reference_number as string) ?? null,
    dial: (row.dial as string) ?? null,
    material: (row.material as string) ?? null,
    year: (row.year as number) ?? null,
    condition: (row.condition as string) ?? null,
    boxPapers: (row.box_papers as string) ?? null,
    otherAttributes: (row.other_attributes as Record<string, unknown>) ?? {},
    askingPrice: row.asking_price === null ? null : Number(row.asking_price),
    maxBid: row.max_bid === null ? null : Number(row.max_bid),
    currency: (row.currency as string) ?? null,
    location: (row.location as string) ?? null,
    country: (row.country as string) ?? null,
    contactName: (row.contact_name as string) ?? null,
    contactMethods: (row.contact_methods as ContactMethod[]) ?? [],
    detailUrl: (row.detail_url as string) ?? null,
    status: row.status as PostingStatus,
    approvedMatchCount: row.approved_match_count as number,
    normalizationConfidence: row.normalization_confidence === null ? null : Number(row.normalization_confidence),
    extractionVersion: (row.extraction_version as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastSeenAt: row.last_seen_at as Date,
    expiresAt: row.expires_at as Date,
    extensionReminderSentAt: (row.extension_reminder_sent_at as Date) ?? null,
  };
}

/**
 * Ingests a chat-originated FS/WTB posting. Idempotent on
 * (source_platform, source_chat_id, source_message_id) -- an edited message
 * updates the existing posting rather than creating a duplicate (spec 5.1).
 */
export async function ingestChatPosting(pool: Pool, input: ChatPostingInput): Promise<IngestResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = await resolveCanonicalUserForPlatformIdentity(client, {
      platform: input.platform,
      platformUserId: input.senderPlatformUserId,
      chatId: input.chatId,
      displayName: input.senderDisplayName,
    });

    const existing = await client.query(
      `SELECT * FROM postings WHERE source_platform = $1 AND source_type = 'chat'
       AND source_chat_id = $2 AND source_message_id = $3 FOR UPDATE`,
      [input.platform, input.chatId, input.messageId]
    );

    const result = await upsertPosting(client, existing.rows[0] as Record<string, unknown> | undefined, {
      canonicalUserId: identity.canonicalUserId,
      sourcePlatform: input.platform,
      sourceType: 'chat',
      sourceChatId: input.chatId,
      sourceMessageId: input.messageId,
      externalListingId: null,
      postingType: input.postingType,
      originalMessage: input.originalMessage,
      originalDescription: input.originalDescription ?? null,
      attrs: input,
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ingests a live WatchFacts API listing. Idempotent on
 * (source, FS/WTB type, external_listing_id); FS and WTB records that share the
 * same numeric external ID remain distinct postings by design (spec 5.1).
 */
export async function ingestApiPosting(pool: Pool, input: ApiPostingInput): Promise<IngestResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let canonicalUserId = input.ownerCanonicalUserId ?? null;
    if (!canonicalUserId) {
      const provisional = await client.query<{ id: string }>(
        `INSERT INTO canonical_users (is_provisional, display_name) VALUES (true, 'WatchFacts API listing')
         RETURNING id`
      );
      canonicalUserId = provisional.rows[0].id;
    }

    const existing = await client.query(
      `SELECT * FROM postings WHERE source_platform = $1 AND source_type = 'api'
       AND posting_type = $2 AND external_listing_id = $3 FOR UPDATE`,
      [input.platform, input.postingType, input.externalListingId]
    );

    const result = await upsertPosting(client, existing.rows[0] as Record<string, unknown> | undefined, {
      canonicalUserId,
      sourcePlatform: input.platform,
      sourceType: 'api',
      sourceChatId: null,
      sourceMessageId: null,
      externalListingId: input.externalListingId,
      postingType: input.postingType,
      originalMessage: null,
      originalDescription: input.originalDescription ?? null,
      attrs: input,
    });

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface UpsertParams {
  canonicalUserId: string;
  sourcePlatform: string;
  sourceType: 'chat' | 'api';
  sourceChatId: string | null;
  sourceMessageId: string | null;
  externalListingId: string | null;
  postingType: 'FS' | 'WTB';
  originalMessage: string | null;
  originalDescription: string | null;
  attrs: {
    brand?: string;
    model?: string;
    referenceNumber?: string;
    dial?: string;
    material?: string;
    year?: number;
    condition?: string;
    boxPapers?: string;
    otherAttributes?: Record<string, unknown>;
    askingPrice?: number;
    maxBid?: number;
    currency?: string;
    location?: string;
    country?: string;
    contactName?: string;
    contactMethods?: ContactMethod[];
    detailUrl?: string;
    normalizationConfidence?: number;
    extractionVersion?: string;
  };
}

async function upsertPosting(
  client: PoolClient,
  existingRow: Record<string, unknown> | undefined,
  p: UpsertParams
): Promise<IngestResult> {
  const a = p.attrs;
  if (!existingRow) {
    const insert = await client.query(
      `INSERT INTO postings (
        canonical_user_id, source_platform, source_type, source_chat_id, source_message_id,
        external_listing_id, posting_type, original_message, original_description,
        brand, model, reference_number, dial, material, year, condition, box_papers,
        other_attributes, asking_price, max_bid, currency, location, country,
        contact_name, contact_methods, detail_url, normalization_confidence, extraction_version,
        last_seen_at, expires_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
        now(), now() + ($29 || ' days')::interval
      ) RETURNING *`,
      [
        p.canonicalUserId,
        p.sourcePlatform,
        p.sourceType,
        p.sourceChatId,
        p.sourceMessageId,
        p.externalListingId,
        p.postingType,
        p.originalMessage,
        p.originalDescription,
        a.brand ?? null,
        a.model ?? null,
        a.referenceNumber ?? null,
        a.dial ?? null,
        a.material ?? null,
        a.year ?? null,
        a.condition ?? null,
        a.boxPapers ?? null,
        JSON.stringify(a.otherAttributes ?? {}),
        a.askingPrice ?? null,
        a.maxBid ?? null,
        a.currency ?? null,
        a.location ?? null,
        a.country ?? null,
        a.contactName ?? null,
        JSON.stringify(a.contactMethods ?? []),
        a.detailUrl ?? null,
        a.normalizationConfidence ?? null,
        a.extractionVersion ?? null,
        DEFAULT_MONITOR_LIFETIME_DAYS,
      ]
    );
    return { posting: rowToPosting(insert.rows[0]), created: true, materiallyChanged: true };
  }

  const update = await client.query(
    `UPDATE postings SET
      original_message = $2, original_description = $3,
      brand = $4, model = $5, reference_number = $6, dial = $7, material = $8, year = $9,
      condition = $10, box_papers = $11, other_attributes = $12, asking_price = $13, max_bid = $14,
      currency = $15, location = $16, country = $17, contact_name = $18, contact_methods = $19,
      detail_url = $20, normalization_confidence = $21, extraction_version = $22,
      last_seen_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      existingRow.id,
      p.originalMessage,
      p.originalDescription,
      a.brand ?? null,
      a.model ?? null,
      a.referenceNumber ?? null,
      a.dial ?? null,
      a.material ?? null,
      a.year ?? null,
      a.condition ?? null,
      a.boxPapers ?? null,
      JSON.stringify(a.otherAttributes ?? {}),
      a.askingPrice ?? null,
      a.maxBid ?? null,
      a.currency ?? null,
      a.location ?? null,
      a.country ?? null,
      a.contactName ?? null,
      JSON.stringify(a.contactMethods ?? []),
      a.detailUrl ?? null,
      a.normalizationConfidence ?? null,
      a.extractionVersion ?? null,
    ]
  );

  const before = rowToPosting(existingRow);
  const after = rowToPosting(update.rows[0]);
  const materiallyChanged = MATERIAL_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));

  return { posting: after, created: false, materiallyChanged };
}

/** Extends a monitor by another 30 days and keeps it active (spec 6.2). */
export async function extendPosting(pool: Pool, postingId: string): Promise<Posting> {
  const { rows } = await pool.query(
    `UPDATE postings SET expires_at = expires_at + ($2 || ' days')::interval,
       extension_reminder_sent_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [postingId, DEFAULT_MONITOR_LIFETIME_DAYS]
  );
  return rowToPosting(rows[0]);
}

export async function setPostingStatus(pool: Pool, postingId: string, status: PostingStatus): Promise<void> {
  await pool.query('UPDATE postings SET status = $2, updated_at = now() WHERE id = $1', [postingId, status]);
}

/** Marks postings past expires_at (still 'active') as 'expired'. Idempotent. */
export async function expireOverduePostings(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE postings SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND expires_at <= now()`
  );
  return rowCount ?? 0;
}

/** Postings whose expires_at falls within the reminder window and haven't been reminded yet. */
export async function findPostingsDueForExtensionReminder(
  pool: Pool,
  reminderDays: number
): Promise<Posting[]> {
  const { rows } = await pool.query(
    `SELECT * FROM postings
     WHERE status = 'active'
       AND extension_reminder_sent_at IS NULL
       AND expires_at <= now() + ($1 || ' days')::interval
       AND expires_at > now()`,
    [reminderDays]
  );
  return rows.map(rowToPosting);
}

export async function markExtensionReminderSent(pool: Pool, postingId: string): Promise<void> {
  await pool.query('UPDATE postings SET extension_reminder_sent_at = now() WHERE id = $1', [postingId]);
}

export { rowToPosting };
