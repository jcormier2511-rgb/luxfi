import crypto from "crypto";
import { config } from "../config";
import { enrichListingText, contentHash } from "../ai/enrichment";
import { getStoredAiHashes } from "./inventoryDb";
import type { UpsertRow } from "./inventoryDb";
import { ListingEnrichment } from "../ai/types";

export interface EnrichmentOutcome {
  /** The rows to actually sync — unchanged content is passed through untouched; changed
   *  unstructured bundles are replaced by one row per watch AI found evidence for. */
  rows: UpsertRow[];
  /** Hash/enrichment to persist AFTER the caller's own upsert — see inventoryDb.saveAiEnrichment. */
  toSave: { type: UpsertRow["type"]; externalId: string; hash: string; enrichment: ListingEnrichment[] }[];
}

/**
 * AI enrichment/splitting step for a WatchFacts sync batch — off entirely (returns `rows`
 * unchanged, no AI calls) unless ENABLE_AI_INVENTORY_ENRICHMENT is on. This is deliberately its
 * own flag, independent of ENABLE_AI_MATCHING (see config.ts) — this runs against the WHOLE
 * inventory on every sync, not scoped to any one test phone's searches, so it needs its own
 * explicit opt-in rather than turning on the moment AI matching is enabled for a single number.
 *
 * Two independent cost controls, since a real feed can be well over a million listings with
 * thousands posted daily:
 * 1. A row that already carries a real deterministic reference is skipped BEFORE any AI call —
 *    a normal single-item WatchFacts listing almost always has one (mapToInventoryListings'
 *    own extraction), so AI only ever runs on the genuinely unstructured "no listings[]
 *    breakdown, no extractable reference" case, which should be a small minority of the feed,
 *    not the default path for every listing.
 * 2. AI_ENRICHMENT_MAX_PER_SYNC hard-caps how many AI calls one sync run will make at all — a
 *    row that would exceed the cap is left unprocessed (no hash saved), so it's simply picked
 *    up on a later sync once capacity allows, rather than a burst of thousands of new
 *    unstructured posts in one day turning into thousands of AI calls in one run.
 *
 * Only calls AI for rows whose content hash actually changed since the last time this ran (see
 * getStoredAiHashes), so a re-sync of unchanged listings costs nothing extra either way.
 *
 * Each derived sub-row's id is keyed on a hash of its own evidence text, not array position —
 * the same watch gets the same id across syncs as long as its evidence text is unchanged,
 * consistent with why mapToInventoryListings keys bundle sub-listings on detail.id rather than
 * position (see watchfacts/api.ts).
 */
export async function enrichAndSplitListings(rows: UpsertRow[], source = "WF"): Promise<EnrichmentOutcome> {
  if (!config.aiMatching.enrichmentEnabled || rows.length === 0) return { rows, toSave: [] };

  const hashes = await getStoredAiHashes(source);
  const outputRows: UpsertRow[] = [];
  const toSave: EnrichmentOutcome["toSave"] = [];
  let aiCallsThisRun = 0;

  for (const row of rows) {
    // Already has a real structured reference — nothing for AI to add, and calling it anyway
    // would multiply cost across the entire feed for zero benefit.
    if (row.ref) {
      outputRows.push(row);
      continue;
    }

    const text = row.description || row.item;
    const hash = contentHash(text);
    const key = `${row.type}:${row.id}`;

    if (hashes.get(key) === hash) {
      outputRows.push(row); // unchanged since the last enrichment pass — skip the AI call entirely
      continue;
    }

    if (aiCallsThisRun >= config.aiMatching.enrichmentMaxPerSync) {
      outputRows.push(row); // this run's cap is reached — retried on a future sync, not dropped
      continue;
    }
    aiCallsThisRun++;

    const enrichment = await enrichListingText(text);
    toSave.push({ type: row.type, externalId: row.id, hash, enrichment });

    if (enrichment.length <= 1) {
      // AI didn't find more than one distinct watch in it — no split needed, the deterministic
      // fields stand as-is.
      outputRows.push(row);
      continue;
    }

    for (const e of enrichment) {
      const subId = `${row.id}-ai-${crypto.createHash("sha256").update(e.evidence).digest("hex").slice(0, 8)}`;
      outputRows.push({
        ...row,
        id: subId,
        item: e.evidence,
        description: e.evidence,
        brand: row.brand || e.brand || "",
        ref: e.referenceRaw || e.referenceFamily || row.ref,
        condition: row.condition || e.condition || "",
        price: e.price != null ? String(e.price) : row.price,
      });
    }
  }

  return { rows: outputRows, toSave };
}
