import { withSchema } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { classifyText, normalizeText, PostingType } from "./normalize";

export interface PostingRow {
  id: number;
  source_platform: string;
  source_type: "chat" | "api";
  source_chat_id: string | null;
  source_message_id: string | null;
  external_listing_id: string | null;
  canonical_user_id: number | null;
  source_identity: string | null;
  type: PostingType;
  original_text: string;
  brand: string;
  reference: string;
  condition: string;
  price: string | null; // NUMERIC comes back as string from pg
  currency: string;
  location: string;
  contact_name: string;
  contact_phone: string;
  detail_url: string;
  status: string;
  approved_match_count: number;
  expires_at: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  return String(a) === String(b);
}

export interface ChatPostingInput {
  platform: string;
  chatId: string;
  messageId: string;
  senderIdentity: string;
  senderName?: string;
  text: string;
}

export interface IngestResult {
  posting: PostingRow | null; // null when the text doesn't classify as FS/WTB at all
  created: boolean;
  materialChange: boolean; // true on create, or on an edit that changed matchable fields
}

/**
 * Chat idempotency key: source_platform + chat/group id + message id (spec §5.1). An edited
 * message updates the existing posting in place rather than creating a duplicate, and
 * `materialChange` tells the caller whether matching needs to rerun.
 */
export async function ingestChatPosting(input: ChatPostingInput): Promise<IngestResult> {
  const type = classifyText(input.text);
  if (!type) return { posting: null, created: false, materialChange: false };

  const canonicalUserId = await getOrCreateCanonicalUser(input.platform, input.senderIdentity);
  const normalized = normalizeText(input.text);
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();

  return withSchema(async (pool) => {
    const existing = await pool.query<PostingRow>(
      `SELECT * FROM postings WHERE source_platform=$1 AND source_chat_id=$2 AND source_message_id=$3 AND source_type='chat'`,
      [input.platform, input.chatId, input.messageId]
    );

    if (existing.rows.length === 0) {
      const insert = await pool.query<PostingRow>(
        `INSERT INTO postings
           (source_platform, source_type, source_chat_id, source_message_id, canonical_user_id, source_identity,
            type, original_text, brand, reference, price, currency, contact_name, contact_phone, status, expires_at)
         VALUES ($1,'chat',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14)
         RETURNING *`,
        [
          input.platform,
          input.chatId,
          input.messageId,
          canonicalUserId,
          input.senderIdentity,
          type,
          input.text,
          normalized.brand,
          normalized.reference,
          normalized.price,
          normalized.currency,
          input.senderName || input.senderIdentity,
          input.senderIdentity,
          expiresAt,
        ]
      );
      return { posting: insert.rows[0], created: true, materialChange: true };
    }

    const old = existing.rows[0];
    const materialChange =
      old.original_text !== input.text ||
      !valuesEqual(old.reference, normalized.reference) ||
      !valuesEqual(old.brand, normalized.brand) ||
      !valuesEqual(old.price, normalized.price);

    const update = await pool.query<PostingRow>(
      `UPDATE postings SET original_text=$1, brand=$2, reference=$3, price=$4, currency=$5,
         updated_at=now(), last_seen_at=now()
       WHERE id=$6 RETURNING *`,
      [input.text, normalized.brand, normalized.reference, normalized.price, normalized.currency, old.id]
    );
    return { posting: update.rows[0], created: false, materialChange };
  });
}

/**
 * Mirrors a live WatchFacts API FS listing into `postings` so the v4 matching engine has one
 * unified source — called from syncInventory.ts after a successful FS sync. Does not touch
 * `inventory_listings`, which keeps serving the existing v3 on-demand search flow unchanged.
 */
export interface ApiFsListing {
  id: string;
  item: string;
  brand: string;
  ref: string;
  condition: string;
  price: string;
  contactName: string;
  contactPhone: string;
  detailUrl?: string;
  description: string;
}

export async function mirrorApiFsPosting(listing: ApiFsListing): Promise<void> {
  const priceNum = Number(listing.price.replace(/[^0-9.]/g, ""));
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
  await withSchema((pool) =>
    pool.query(
      `INSERT INTO postings
         (source_platform, source_type, external_listing_id, type, original_text, brand, reference, condition,
          price, contact_name, contact_phone, detail_url, status, expires_at, last_seen_at)
       VALUES ('watchfacts_api','api',$1,'FS',$2,$3,$4,$5,$6,$7,$8,$9,'active',$10, now())
       ON CONFLICT (source_platform, type, external_listing_id) WHERE source_type = 'api' DO UPDATE SET
         original_text = excluded.original_text, brand = excluded.brand, reference = excluded.reference,
         condition = excluded.condition, price = excluded.price, contact_name = excluded.contact_name,
         contact_phone = excluded.contact_phone, detail_url = excluded.detail_url, status = 'active',
         updated_at = now(), last_seen_at = now()`,
      [
        listing.id,
        listing.description || listing.item,
        listing.brand,
        listing.ref,
        listing.condition,
        Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null,
        listing.contactName,
        listing.contactPhone,
        listing.detailUrl ?? "",
        expiresAt,
      ]
    )
  );
}

/** Mirrors markMissingInactive for the API-mirrored postings — only called after a fully successful FS sync. */
export async function markApiPostingsInactive(seenExternalIds: string[]): Promise<void> {
  if (seenExternalIds.length === 0) return;
  await withSchema((pool) =>
    pool.query(
      `UPDATE postings SET status='source_inactive', updated_at=now()
       WHERE source_type='api' AND type='FS' AND status='active' AND external_listing_id <> ALL($1::text[])`,
      [seenExternalIds]
    )
  );
}

export function isEligible(posting: Pick<PostingRow, "status" | "expires_at">): boolean {
  return posting.status === "active" && new Date(posting.expires_at) > new Date();
}

export async function getPosting(id: number): Promise<PostingRow | null> {
  return withSchema(async (pool) => {
    const result = await pool.query<PostingRow>(`SELECT * FROM postings WHERE id=$1`, [id]);
    return result.rows[0] ?? null;
  });
}

/** Active, eligible postings of the opposite type to `posting`, excluding the same owner (spec §7: never match a user with their own listing). */
export async function findOppositeSideCandidates(posting: PostingRow): Promise<PostingRow[]> {
  const oppositeType: PostingType = posting.type === "FS" ? "WTB" : "FS";
  return withSchema(async (pool) => {
    const result = await pool.query<PostingRow>(
      `SELECT * FROM postings
       WHERE type = $1 AND status = 'active' AND expires_at > now()
         AND canonical_user_id IS DISTINCT FROM $2`,
      [oppositeType, posting.canonical_user_id]
    );
    return result.rows;
  });
}

export async function extendPosting(id: number): Promise<PostingRow | null> {
  return withSchema(async (pool) => {
    const result = await pool.query<PostingRow>(
      `UPDATE postings SET expires_at = expires_at + INTERVAL '30 days', updated_at = now()
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [id]
    );
    return result.rows[0] ?? null;
  });
}

export async function closePosting(id: number, status: "sold" | "found" | "stopped" | "admin_closed"): Promise<void> {
  await withSchema((pool) => pool.query(`UPDATE postings SET status=$1, updated_at=now() WHERE id=$2`, [status, id]));
}

/** Run on a schedule — expires postings past their expires_at that haven't been extended. */
export async function expireStalePostings(): Promise<number> {
  return withSchema(async (pool) => {
    const result = await pool.query(
      `UPDATE postings SET status='expired', updated_at=now()
       WHERE status='active' AND expires_at <= now() RETURNING id`
    );
    return result.rowCount ?? 0;
  });
}
