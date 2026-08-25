import { config } from "../config";
import { Contact } from "../types";
import { getTierABContacts } from "../data/contactsStore";
import { sendBannerImage, sendText } from "../whapi/client";
import { getState, saveState } from "../conversation/stateStore";
import { readBlastStatus, writeBlastStatus } from "./status";
import { openWatchFactsSession, WatchFactsSession, LatestListing } from "../watchfacts/scraper";

function renderIntro(template: string, name: string): string {
  return template.replace(/\{\{\s*name\s*\}\}/g, name).replace(/\\n/g, "\n");
}

function highlightLine(listing: LatestListing): string {
  const priceText = listing.price && listing.price !== "$0.00" ? ` for ${listing.price}` : "";
  return `Saw you just posted "${listing.title}"${priceText} — nice piece.\n\n`;
}

/**
 * Opens a WatchFacts session for the batch if the feature is enabled and at least one
 * contact has a profile id. Never throws — a login/scrape failure just means the batch
 * proceeds with plain (non-personalized) intros instead of blocking outreach entirely.
 */
async function tryOpenWatchFactsSession(batch: Contact[]): Promise<WatchFactsSession | null> {
  if (!config.watchfacts.enabled || !batch.some((c) => c.wfProfileId)) return null;
  try {
    return await openWatchFactsSession();
  } catch (err) {
    console.error("[watchfacts] session open failed — sending plain intros for this batch:", err);
    return null;
  }
}

async function fetchHighlight(session: WatchFactsSession | null, contact: Contact): Promise<string> {
  if (!session || !contact.wfProfileId) return "";
  try {
    const listing = await session.getLatestListing(contact.wfProfileId);
    return listing ? highlightLine(listing) : "";
  } catch (err) {
    console.error(`[watchfacts] failed to fetch listing for ${contact.name} (${contact.wfProfileId}):`, err);
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BlastPlan {
  totalContacts: number;
  alreadyContacted: number;
  batch: Contact[];
  remainingAfterBatch: number;
}

/** Pure/sync: figures out who would be messaged by a run right now, without sending anything. */
export function planOutreachBatch(): BlastPlan {
  const contacts = getTierABContacts();
  const pending = contacts.filter((c) => getState(c.phone).stage === "new");
  const batch = config.outreach.batchLimit > 0 ? pending.slice(0, config.outreach.batchLimit) : pending;
  return {
    totalContacts: contacts.length,
    alreadyContacted: contacts.length - pending.length,
    batch,
    remainingAfterBatch: pending.length - batch.length,
  };
}

export interface BlastSummary {
  attempted: number;
  sent: number;
  skipped: number;
  remaining: number;
  failed: { phone: string; error: string }[];
}

/**
 * Sends the intro message + banner to the given batch, paced at `ratePerHour`.
 * Updates the on-disk status after each send so /outreach/status (and process restarts)
 * can reflect live progress across what may be a many-hour run.
 */
export async function executeOutreachBatch(plan: BlastPlan): Promise<BlastSummary> {
  writeBlastStatus({
    state: "running",
    startedAt: new Date().toISOString(),
    batchSize: plan.batch.length,
    sent: 0,
    failed: [],
  });

  const failed: { phone: string; error: string }[] = [];
  const wfSession = await tryOpenWatchFactsSession(plan.batch);
  try {
    for (let i = 0; i < plan.batch.length; i++) {
      const contact = plan.batch[i];
      const state = getState(contact.phone);
      try {
        const highlight = await fetchHighlight(wfSession, contact);
        const message = highlight + renderIntro(config.outreach.introMessage, contact.name);
        if (config.outreach.bannerImageUrl) {
          await sendBannerImage(contact.phone, config.outreach.bannerImageUrl, message);
        } else {
          await sendText(contact.phone, message);
        }
        saveState({ ...state, stage: "new" }); // touch updatedAt so we can audit send time
      } catch (err) {
        failed.push({ phone: contact.phone, error: (err as Error).message });
      }
      writeBlastStatus({
        state: "running",
        startedAt: readBlastStatus().startedAt,
        batchSize: plan.batch.length,
        sent: i + 1 - failed.length,
        failed,
      });
      if (i < plan.batch.length - 1) {
        await sleep(config.outreach.delayMs);
      }
    }
  } finally {
    await wfSession?.close();
  }

  const summary: BlastSummary = {
    attempted: plan.totalContacts,
    sent: plan.batch.length - failed.length,
    skipped: plan.alreadyContacted,
    remaining: plan.remainingAfterBatch,
    failed,
  };

  writeBlastStatus({
    state: "completed",
    startedAt: readBlastStatus().startedAt,
    finishedAt: new Date().toISOString(),
    batchSize: plan.batch.length,
    sent: summary.sent,
    failed,
  });

  return summary;
}

/** Convenience for the CLI script: plans and runs to completion, awaiting the whole batch. */
export async function runOutreachBlast(): Promise<BlastSummary> {
  const plan = planOutreachBatch();
  return executeOutreachBatch(plan);
}
