import { withSchema } from "./db";
import { PostingRow, findOppositeSideCandidates, isEligible } from "./postingsStore";
import { notifyMatch } from "./notify";

export interface ScoreResult {
  score: number;
  reasons: string[];
}

/**
 * Structured matching only (spec §7) — reference-number exact match is highest priority; a
 * broader match is allowed only when the WTB side gave no reference/brand at all (so a vague
 * "WTB Rolex" doesn't flood every Rolex FS listing with a low-confidence match, but a truly
 * unconstrained "looking for a nice watch" can still surface something). A stated hard max
 * bid is always respected when both sides have a price.
 */
export function scoreMatch(fs: PostingRow, wtb: PostingRow): ScoreResult | null {
  const reasons: string[] = [];
  let score = 0;

  const fsRef = fs.reference?.toUpperCase();
  const wtbRef = wtb.reference?.toUpperCase();
  const fsBrand = fs.brand?.toLowerCase();
  const wtbBrand = wtb.brand?.toLowerCase();

  if (fsRef && wtbRef && fsRef === wtbRef) {
    score += 100;
    reasons.push(`Exact reference match: ${fs.reference}`);
  } else if (fsBrand && wtbBrand && fsBrand === wtbBrand) {
    score += 20;
    reasons.push(`Same brand: ${fs.brand}`);
  } else if (!wtbRef && !wtbBrand) {
    score += 5;
    reasons.push("Broad match — no reference or brand specified in the request");
  } else {
    return null; // no structured basis for a match
  }

  const fsPrice = fs.price !== null ? Number(fs.price) : null;
  const wtbMaxBid = wtb.price !== null ? Number(wtb.price) : null;
  if (fsPrice !== null && wtbMaxBid !== null) {
    if (fsPrice > wtbMaxBid) return null; // hard max bid respected
    reasons.push(`Within budget ($${fsPrice} ≤ $${wtbMaxBid})`);
  }

  return { score, reasons };
}

/**
 * One row per FS/WTB pair (spec §7/§12 unique match identity). Re-discovering an identical
 * match (same score/reasons — e.g. via the reconciliation sweep) is a no-op, not a new
 * revision; a genuinely different score/reasons (a material change on either posting) bumps
 * the revision, which is what allows a previously-passed match to be resurfaced.
 */
export async function upsertMatch(
  fsPostingId: number,
  wtbPostingId: number,
  result: ScoreResult
): Promise<{ matchId: number; revision: number; isNewOrChanged: boolean }> {
  return withSchema(async (pool) => {
    const existing = await pool.query(`SELECT * FROM matches WHERE fs_posting_id=$1 AND wtb_posting_id=$2`, [
      fsPostingId,
      wtbPostingId,
    ]);

    if (existing.rows.length === 0) {
      const insert = await pool.query(
        `INSERT INTO matches (fs_posting_id, wtb_posting_id, score, reasons, revision) VALUES ($1,$2,$3,$4,1) RETURNING id, revision`,
        [fsPostingId, wtbPostingId, result.score, result.reasons]
      );
      return { matchId: insert.rows[0].id, revision: insert.rows[0].revision, isNewOrChanged: true };
    }

    const old = existing.rows[0];
    const reasonsChanged = JSON.stringify(old.reasons) !== JSON.stringify(result.reasons);
    if (old.score !== result.score || reasonsChanged) {
      const newRevision = old.revision + 1;
      await pool.query(`UPDATE matches SET score=$1, reasons=$2, revision=$3, updated_at=now() WHERE id=$4`, [
        result.score,
        result.reasons,
        newRevision,
        old.id,
      ]);
      return { matchId: old.id, revision: newRevision, isNewOrChanged: true };
    }
    return { matchId: old.id, revision: old.revision, isNewOrChanged: false };
  });
}

export interface ImmediateMatchResult {
  matchesFound: number;
}

/**
 * Tests every active opposite-side posting against `posting` (spec §4.3: a new/changed
 * posting must be tested against every eligible active posting on the other side). Called on
 * ingestion (both create and material-change) so the poster is never required to repost or
 * ask Fi to search again.
 */
export async function runImmediateMatch(posting: PostingRow): Promise<ImmediateMatchResult> {
  if (!isEligible(posting)) return { matchesFound: 0 };

  const candidates = await findOppositeSideCandidates(posting);
  let matchesFound = 0;

  for (const candidate of candidates) {
    const [fs, wtb] = posting.type === "FS" ? [posting, candidate] : [candidate, posting];
    const result = scoreMatch(fs, wtb);
    if (!result) continue;

    const { matchId, revision, isNewOrChanged } = await upsertMatch(fs.id, wtb.id, result);
    matchesFound++;
    if (isNewOrChanged) {
      await notifyMatch(matchId, revision);
    }
  }

  return { matchesFound };
}

export interface ReconciliationResult {
  matchesCreatedOrChanged: number;
  error?: string;
}

/**
 * Periodic safety net (spec §4.3) — sweeps every active WTB against every active FS to
 * recover matches missed because of a webhook/API/process failure. Reuses the same
 * upsertMatch/notify path, so an already-known, unchanged match is a no-op (no duplicate
 * notification) and a genuinely new pairing gets created and notified exactly like the
 * immediate path would have.
 */
export async function runReconciliation(): Promise<ReconciliationResult> {
  return withSchema(async (pool) => {
    const started = await pool.query(`INSERT INTO reconciliation_runs DEFAULT VALUES RETURNING id`);
    const runId = started.rows[0].id;
    try {
      const [fsRows, wtbRows] = await Promise.all([
        pool.query<PostingRow>(`SELECT * FROM postings WHERE type='FS' AND status='active' AND expires_at > now()`),
        pool.query<PostingRow>(`SELECT * FROM postings WHERE type='WTB' AND status='active' AND expires_at > now()`),
      ]);

      let matchesCreatedOrChanged = 0;
      for (const wtb of wtbRows.rows) {
        for (const fs of fsRows.rows) {
          if (fs.canonical_user_id !== null && fs.canonical_user_id === wtb.canonical_user_id) continue; // no self-match
          const result = scoreMatch(fs, wtb);
          if (!result) continue;
          const { matchId, revision, isNewOrChanged } = await upsertMatch(fs.id, wtb.id, result);
          if (isNewOrChanged) {
            matchesCreatedOrChanged++;
            await notifyMatch(matchId, revision);
          }
        }
      }

      await pool.query(`UPDATE reconciliation_runs SET finished_at=now(), matches_created=$1 WHERE id=$2`, [
        matchesCreatedOrChanged,
        runId,
      ]);
      return { matchesCreatedOrChanged };
    } catch (err) {
      const message = (err as Error).message;
      await pool.query(`UPDATE reconciliation_runs SET finished_at=now(), error=$1 WHERE id=$2`, [message, runId]);
      return { matchesCreatedOrChanged: 0, error: message };
    }
  });
}
