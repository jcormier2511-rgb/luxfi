import { Pool } from 'pg';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

export interface AddImageInput {
  postingId: string;
  sourceMediaId?: string;
  sourceUrl?: string;
  storageKey?: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  displayOrder?: number;
  isPrimary?: boolean;
}

export class InvalidImageError extends Error {}

function validate(input: AddImageInput): void {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new InvalidImageError(`unsupported mime type: ${input.mimeType}`);
  }
  if (input.fileSize <= 0 || input.fileSize > MAX_FILE_SIZE_BYTES) {
    throw new InvalidImageError(`file size out of bounds: ${input.fileSize}`);
  }
  if (input.sourceUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.sourceUrl);
    } catch {
      throw new InvalidImageError('invalid source URL');
    }
    if (parsed.protocol !== 'https:') {
      // Prevent unsafe server-side fetching of arbitrary/internal schemes (spec 8.3).
      throw new InvalidImageError('only https source URLs are accepted');
    }
  }
}

/**
 * Attaches an image to a posting. Deduplicates by (posting_id, content_hash)
 * (spec 8.2/8.3). Never throws for callers that treat image failures as
 * non-fatal to ingestion -- catch InvalidImageError at the call site and
 * continue (spec: "An absent image or failed image download must never
 * prevent posting ingestion, matching, synchronization, or notification").
 */
export async function addPostingImage(pool: Pool, input: AddImageInput): Promise<string | null> {
  validate(input);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.isPrimary) {
      await client.query('UPDATE posting_images SET is_primary = false WHERE posting_id = $1', [input.postingId]);
    }
    const { rows } = await client.query(
      `INSERT INTO posting_images
         (posting_id, source_media_id, source_url, storage_key, mime_type, file_size, content_hash, display_order, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (posting_id, content_hash) DO UPDATE SET
         is_primary = EXCLUDED.is_primary OR posting_images.is_primary
       RETURNING id`,
      [
        input.postingId,
        input.sourceMediaId ?? null,
        input.sourceUrl ?? null,
        input.storageKey ?? null,
        input.mimeType,
        input.fileSize,
        input.contentHash,
        input.displayOrder ?? 0,
        input.isPrimary ?? false,
      ]
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getPrimaryImage(pool: Pool, postingId: string): Promise<{ sourceUrl: string | null; storageKey: string | null } | null> {
  const { rows } = await pool.query(
    'SELECT source_url, storage_key FROM posting_images WHERE posting_id = $1 AND is_primary = true LIMIT 1',
    [postingId]
  );
  if (rows.length === 0) return null;
  return { sourceUrl: rows[0].source_url, storageKey: rows[0].storage_key };
}

/** Best-effort wrapper: swallows InvalidImageError so ingestion never blocks on a bad image. */
export async function tryAddPostingImage(pool: Pool, input: AddImageInput): Promise<void> {
  try {
    await addPostingImage(pool, input);
  } catch (err) {
    if (err instanceof InvalidImageError) {
      // eslint-disable-next-line no-console
      console.warn(`[images] rejected image for posting ${input.postingId}: ${err.message}`);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[images] failed to store image for posting ${input.postingId}: ${(err as Error).message}`);
  }
}
