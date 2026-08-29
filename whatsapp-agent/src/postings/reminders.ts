import { findPostingsNeedingReminder, claimReminderForPosting, PostingRow } from "./postingsStore";
import { sendText } from "../whapi/client";
import { config, isPostingChatEnabled } from "../config";

function watchLabel(posting: PostingRow): string {
  if (posting.reference) return `${posting.brand || ""} ${posting.reference}`.trim();
  return posting.original_text.slice(0, 80);
}

function formatReminderMessage(posting: PostingRow): string {
  const daysLeft = Math.max(0, Math.ceil((new Date(posting.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  const noun = posting.type === "WTB" ? "request" : "listing";
  return (
    `Your ${noun} for "${watchLabel(posting)}" expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.\n` +
    `Reply "extend ${posting.id}" to renew it for 15 more days.`
  );
}

// Same re-entrancy pattern as syncInventory.ts's syncRunning: an overlapping scheduler tick
// (this run still in flight when the next interval fires) just skips rather than queues.
// This is what lets the reminder itself be claimed-as-sent AFTER a successful send rather
// than before — retry-safety (never permanently marking a failed send as sent) matters more
// here than perfect duplicate-avoidance across two truly concurrent runs, and this guard
// already rules out the realistic case (this same process's own overlapping ticks).
let reminderRunInProgress = false;

/**
 * Run on a schedule (see index.ts) — asks a poster before their own monitor expires, per
 * spec, rather than letting it silently lapse. Each candidate's send is individually
 * try/caught so one failed delivery never blocks the rest of the batch, matching the
 * non-blocking pattern already used for image lookups/writes elsewhere in this system.
 *
 * Retry-safe by construction: reminder_sent_for_expires_at is only claimed AFTER sendText
 * resolves successfully. A failed send leaves the posting untouched, so it's picked up again
 * by findPostingsNeedingReminder on the very next run — never permanently marked "sent" for
 * a message that never actually went out.
 *
 * Chat-allowlist-aware: a posting whose originating group is no longer allowed (removed from
 * V4_ALLOWED_CHAT_IDS, or the master flag turned off) is skipped entirely — checked here at
 * send time, not just once at ingestion, so a later allowlist change takes effect immediately
 * for postings already sitting in the table.
 */
export async function sendExpirationReminders(): Promise<{ remindersSent: number }> {
  if (reminderRunInProgress) return { remindersSent: 0 };
  reminderRunInProgress = true;

  try {
    const candidates = await findPostingsNeedingReminder(config.postingsV4.reminderDaysBeforeExpiry);
    let remindersSent = 0;

    for (const posting of candidates) {
      if (!isPostingChatEnabled(posting)) continue; // group no longer allowed — never remind
      if (!posting.contact_phone) continue;

      try {
        await sendText(posting.contact_phone, formatReminderMessage(posting));
      } catch (err) {
        console.error(`[postings] failed to send expiration reminder for posting ${posting.id} — will retry next run:`, err);
        continue; // do NOT claim — must remain eligible for the next run
      }

      const claimed = await claimReminderForPosting(posting.id);
      if (claimed) remindersSent++;
    }

    return { remindersSent };
  } finally {
    reminderRunInProgress = false;
  }
}
