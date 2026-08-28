import { Pool } from 'pg';
import { getMessagingAdapter } from '../adapters/messaging.adapter';
import { rowToPosting } from './posting.service';
import { getPrimaryImage } from './image.service';
import { Posting } from '../types/domain';

function formatPriceSignal(fs: Posting): string | null {
  if (fs.askingPrice == null) return null;
  // MVP: no live market-pricing feed is wired up. A real implementation would
  // compare against recent comparable sales; for now we simply omit the signal
  // rather than fabricate one, per spec 9.1 ("when available").
  return null;
}

function buildMessageText(params: {
  surfacedPosting: Posting;
  score: number;
  reasons: string[];
}): string {
  const { surfacedPosting: p, score, reasons } = params;
  const priceLine = p.askingPrice != null
    ? `${p.askingPrice} ${p.currency ?? ''}`.trim()
    : p.maxBid != null
      ? `up to ${p.maxBid} ${p.currency ?? ''}`.trim()
      : 'Not specified';

  const lines = [
    'Potential Match',
    `Type: ${p.postingType}`,
    `Watch: ${[p.brand, p.model, p.referenceNumber].filter(Boolean).join(' ') || p.originalDescription || 'Details pending'}`,
    `Asking/Bid: ${priceLine}`,
    `Location: ${[p.location, p.country].filter(Boolean).join(', ') || 'Not specified'}`,
    '',
    'Fi Intelligence',
    `- Match score: ${score}`,
    ...reasons.map((r) => `- ${r}`),
    '',
    '[Approve match] [Pass]',
  ];
  return lines.join('\n');
}

/**
 * Creates (idempotently) and sends the Potential Match notification for every
 * recipient of a match revision that doesn't already have one (spec 9.1,
 * notification dedup). Safe to call repeatedly / from reconciliation.
 */
export async function createAndSendNotificationsForMatchRevision(
  pool: Pool,
  matchId: string,
  revision: number
): Promise<void> {
  const { rows: matchRows } = await pool.query('SELECT * FROM matches WHERE id = $1', [matchId]);
  if (matchRows.length === 0) return;
  const match = matchRows[0];

  const { rows: postingRows } = await pool.query('SELECT * FROM postings WHERE id = ANY($1)', [
    [match.fs_posting_id, match.wtb_posting_id],
  ]);
  const postingsById = new Map(postingRows.map((r) => [r.id, rowToPosting(r)]));
  const fsPosting = postingsById.get(match.fs_posting_id);
  const wtbPosting = postingsById.get(match.wtb_posting_id);
  if (!fsPosting || !wtbPosting) return;

  const { rows: recipientRows } = await pool.query(
    `SELECT * FROM match_recipients WHERE match_id = $1 AND match_revision = $2 AND decision = 'pending'`,
    [matchId, revision]
  );

  const adapter = getMessagingAdapter();

  for (const recipient of recipientRows) {
    const recipientIsFsOwner = recipient.recipient_canonical_user_id === fsPosting.canonicalUserId;
    // Each side is shown the *other* side's posting.
    const surfacedPosting = recipientIsFsOwner ? wtbPosting : fsPosting;

    const insert = await pool.query(
      `INSERT INTO notifications (match_id, recipient_canonical_user_id, match_revision, channel, status)
       VALUES ($1, $2, $3, 'stub', 'pending')
       ON CONFLICT (match_id, recipient_canonical_user_id, match_revision) DO NOTHING
       RETURNING id`,
      [matchId, recipient.recipient_canonical_user_id, revision]
    );
    if (insert.rows.length === 0) continue; // already notified for this revision

    const notificationId = insert.rows[0].id;
    const text = buildMessageText({
      surfacedPosting,
      score: Number(match.score),
      reasons: (match.reasons as string[]) ?? [],
    });
    void formatPriceSignal(surfacedPosting); // reserved for a future live pricing feed
    const primaryImage = await getPrimaryImage(pool, surfacedPosting.id);

    const result = await adapter.send({
      recipientCanonicalUserId: recipient.recipient_canonical_user_id,
      text,
      imageUrl: primaryImage?.sourceUrl ?? primaryImage?.storageKey ?? null,
      buttons: [
        { label: 'Approve match', action: `approve:${matchId}` },
        { label: 'Pass', action: `pass:${matchId}` },
      ],
    });

    if (result.ok) {
      await pool.query(
        `UPDATE notifications SET status = 'sent', sent_at = now() WHERE id = $1`,
        [notificationId]
      );
      await pool.query(
        `UPDATE match_recipients SET delivered_at = now()
         WHERE match_id = $1 AND recipient_canonical_user_id = $2 AND match_revision = $3`,
        [matchId, recipient.recipient_canonical_user_id, revision]
      );
    } else {
      await pool.query(
        `UPDATE notifications SET status = 'failed', error = $2 WHERE id = $1`,
        [notificationId, result.error ?? 'unknown error']
      );
    }
  }
}
