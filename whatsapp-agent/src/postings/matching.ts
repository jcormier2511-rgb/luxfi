import { withSchema } from "./db";
import { PostingRow, findOppositeSideCandidates, isEligible } from "./postingsStore";
import { notifyMatch } from "./notify";
import { normalizeReference, referencesMatch } from "./normalize";
import { convertMoneyToUsd } from "../matching/currency";

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
 *
 * Critical rule: when BOTH sides specified a reference, they must resolve to the same watch
 * (see referencesMatch — exact, or one is a bare-base prefix of the other's suffixed variant)
 * outright — this never falls through to the same-brand fallback. Two genuinely different
 * references on the same brand (e.g. a WTB for 116500LN against an FS for 116508-0013) are not
 * a match; showing one anyway because "at least it's the same brand" is worse than showing
 * nothing.
 */
export function scoreMatch(fs: PostingRow, wtb: PostingRow): ScoreResult | null {
  const reasons: string[] = [];
  let score = 0;

  const fsRef = fs.reference ? normalizeReference(fs.reference) : "";
  const wtbRef = wtb.reference ? normalizeReference(wtb.reference) : "";
  const fsBrand = fs.brand?.toLowerCase();
  const wtbBrand = wtb.brand?.toLowerCase();

  if (fsRef && wtbRef) {
    if (!referencesMatch(fs.reference!, wtb.reference!)) return null; // both specified a reference — must resolve to the same watch, no fallback
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

  const canonical = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const requestedDial = canonical(wtb.dial || "");
  if (requestedDial && requestedDial !== "any" && requestedDial !== "either") {
    if (!fs.dial || canonical(fs.dial) !== requestedDial) return null;
    reasons.push(`Dial: ${wtb.dial}`);
  }
  const requestedCondition = canonical(wtb.condition || "");
  if (requestedCondition && requestedCondition !== "any" && requestedCondition !== "anycondition") {
    if (!fs.condition || canonical(fs.condition) !== requestedCondition) return null;
    reasons.push(`Condition: ${wtb.condition}`);
  }
  const locationAlias = (value: string) => {
    const normalized = canonical(value);
    return ["us", "usa", "unitedstates"].includes(normalized) ? "us" : normalized;
  };
  const requestedLocation = locationAlias(wtb.location || "");
  if (requestedLocation && requestedLocation !== "any") {
    if (!fs.location || locationAlias(fs.location) !== requestedLocation) return null;
    reasons.push(`Location: ${wtb.location}`);
  }

  const fsPrice = fs.price !== null ? Number(fs.price) : null;
  const wtbMaxBid = wtb.price !== null ? Number(wtb.price) : null;
  if (fsPrice !== null && wtbMaxBid !== null) {
    if ((fs.currency || "USD") !== (wtb.currency || "USD")) return null;
    if (fsPrice > wtbMaxBid) return null; // hard max bid respected
    reasons.push(`Within budget ($${fsPrice} ≤ $${wtbMaxBid})`);
  }

  return { score, reasons };
}

/** Runtime matcher with conservative FX conversion for cross-currency hard budgets. */
export async function scoreMatchWithCurrency(fs: PostingRow, wtb: PostingRow): Promise<ScoreResult | null> {
  if ((fs.currency || "USD") === (wtb.currency || "USD") || fs.price === null || wtb.price === null) return scoreMatch(fs, wtb);
  const withoutPrices = scoreMatch({ ...fs, price: null }, { ...wtb, price: null });
  if (!withoutPrices) return null;
  const [fsUsd, budgetUsd] = await Promise.all([
    convertMoneyToUsd({ amount: Number(fs.price), currency: fs.currency as any }),
    convertMoneyToUsd({ amount: Number(wtb.price), currency: wtb.currency as any }),
  ]);
  if (fsUsd === null || budgetUsd === null || fsUsd > budgetUsd) return null;
  return { ...withoutPrices, reasons: [...withoutPrices.reasons, `Within converted budget (${fs.currency} ${fs.price} ≤ ${wtb.currency} ${wtb.price})`] };
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
    const result = await scoreMatchWithCurrency(fs, wtb);
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
          const result = await scoreMatchWithCurrency(fs, wtb);
          if (!result) continue;
          const { matchId, revision, isNewOrChanged } = await upsertMatch(fs.id, wtb.id, result);
          if (isNewOrChanged) matchesCreatedOrChanged++;
          // notifyMatch is idempotent for already-delivered recipients. Calling it for an
          // unchanged pair lets a previously capped or transiently failed candidate become
          // presentable after an administrator raises the listing limit or delivery recovers.
          await notifyMatch(matchId, revision);
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
