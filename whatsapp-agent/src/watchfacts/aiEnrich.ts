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
 * unchanged, no AI calls) unless ENABLE_AI_MATCHING is on. Only calls AI for rows whose content
 * hash actually changed since the last time this ran (see getStoredAiHashes), so a re-sync of
 * unchanged listings costs nothing extra. A row that already carries a real deterministic
 * reference, or where AI found at most one watch in it, is left exactly as the deterministic
 * mapper produced it — enrichment only steps in for a genuinely unstructured multi-watch blast
 * (no `listings[]` breakdown from WatchFacts itself), splitting it into one row per watch.
 *
 * Each derived sub-row's id is keyed on a hash of its own evidence text, not array position —
 * the same watch gets the same id across syncs as long as its evidence text is unchanged,
 * consistent with why mapToInventoryListings keys bundle sub-listings on detail.id rather than
 * position (see watchfacts/api.ts).
 */
export async function enrichAndSplitListings(rows: UpsertRow[], source = "WF"): Promise<EnrichmentOutcome> {
  if (!config.aiMatching.enabled || rows.length === 0) return { rows, toSave: [] };

  const hashes = await getStoredAiHashes(source);
  const outputRows: UpsertRow[] = [];
  const toSave: EnrichmentOutcome["toSave"] = [];

  for (const row of rows) {
    const text = row.description || row.item;
    const hash = contentHash(text);
    const key = `${row.type}:${row.id}`;

    if (hashes.get(key) === hash) {
      outputRows.push(row); // unchanged since the last enrichment pass — skip the AI call entirely
      continue;
    }

    const enrichment = await enrichListingText(text);
    toSave.push({ type: row.type, externalId: row.id, hash, enrichment });

    if (row.ref || enrichment.length <= 1) {
      // Already has a real structured reference, or AI didn't find more than one distinct
      // watch in it — no split needed, the deterministic fields stand as-is.
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
