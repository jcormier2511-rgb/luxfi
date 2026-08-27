import { findPostingsNeedingReminder, claimReminderForPosting, PostingRow } from "./postingsStore";
import { sendText } from "../whapi/client";
import { config } from "../config";

function watchLabel(posting: PostingRow): string {
  if (posting.reference) return `${posting.brand || ""} ${posting.reference}`.trim();
  return posting.original_text.slice(0, 80);
}

function formatReminderMessage(posting: PostingRow): string {
  const daysLeft = Math.max(0, Math.ceil((new Date(posting.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  const noun = posting.type === "WTB" ? "request" : "listing";
  return (
    `Your ${noun} for "${watchLabel(posting)}" expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.\n` +
    `Reply "extend ${posting.id}" to keep it active for 30 more days.`
  );
}

/**
 * Run on a schedule (see index.ts) — asks a poster before their own monitor expires, per
 * spec, rather than letting it silently lapse. Each candidate's send is individually
 * try/caught so one failed delivery never blocks the rest of the batch, matching the
 * non-blocking pattern already used for image lookups/writes elsewhere in this system.
 */
export async function sendExpirationReminders(): Promise<{ remindersSent: number }> {
  const candidates = await findPostingsNeedingReminder(config.postingsV4.reminderDaysBeforeExpiry);
  let remindersSent = 0;

  for (const posting of candidates) {
    const claimed = await claimReminderForPosting(posting.id);
    if (!claimed) continue; // already reminded for this exact expiry by a concurrent/earlier run
    if (!claimed.contact_phone) continue;

    try {
      await sendText(claimed.contact_phone, formatReminderMessage(claimed));
      remindersSent++;
    } catch (err) {
      console.error(`[postings] failed to send expiration reminder for posting ${posting.id}:`, err);
    }
  }

  return { remindersSent };
}
