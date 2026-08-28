import { Pool } from 'pg';
import { expireOverduePostings, findPostingsDueForExtensionReminder, markExtensionReminderSent } from './posting.service';
import { sendExtensionReminder } from './conversation.service';

const DEFAULT_REMINDER_DAYS = Number(process.env.MONITOR_EXTENSION_REMINDER_DAYS ?? '3');

/** Sends extension reminders and expires overdue monitors (spec section 6.2). */
export async function runMonitorLifecycleJob(pool: Pool): Promise<{ expired: number; remindersSent: number }> {
  const due = await findPostingsDueForExtensionReminder(pool, DEFAULT_REMINDER_DAYS);
  for (const posting of due) {
    const daysLeft = Math.max(0, Math.ceil((posting.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    await sendExtensionReminder(posting.canonicalUserId, daysLeft);
    await markExtensionReminderSent(pool, posting.id);
  }
  const expired = await expireOverduePostings(pool);
  return { expired, remindersSent: due.length };
}
