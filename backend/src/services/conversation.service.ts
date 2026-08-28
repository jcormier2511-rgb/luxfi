import { Pool } from 'pg';
import { getMessagingAdapter } from '../adapters/messaging.adapter';

const FIRST_CONTACT_MESSAGE = `Hi, I'm Fi -- your personal luxury concierge.
I'm here to help you:
1. Find a buyer
2. Find a seller
3. Check pricing and market trends
4. Check dealer reputation and references

I'll automatically monitor your listings and work on your first 3 approved matches at no charge so you can see what I can do.`;

/**
 * Sends the first-contact message exactly once per canonical account, no
 * matter how many postings/groups/phone numbers later link to it (spec
 * section 10). Locks the row to avoid a duplicate send race.
 */
export async function sendFirstContactIfNeeded(pool: Pool, canonicalUserId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT first_contact_sent_at FROM canonical_users WHERE id = $1 FOR UPDATE',
      [canonicalUserId]
    );
    if (rows.length === 0 || rows[0].first_contact_sent_at) {
      await client.query('COMMIT');
      return false;
    }
    await client.query('UPDATE canonical_users SET first_contact_sent_at = now() WHERE id = $1', [canonicalUserId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await getMessagingAdapter().send({ recipientCanonicalUserId: canonicalUserId, text: FIRST_CONTACT_MESSAGE });
  return true;
}

export async function sendMonitoringAcknowledgment(canonicalUserId: string): Promise<void> {
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: "I'm monitoring this request. I'll let you know automatically when I find a qualifying buyer or seller.",
  });
}

function conversionMessage(firstName: string, isWatchFactsMember: boolean): string {
  if (isWatchFactsMember) {
    return `Hi ${firstName}, I hope you've enjoyed having me work for you.
Your $50/month Fi membership is included with WatchFacts. To continue approving introductions, authorize the $2 per-approved-match charge.`;
  }
  return `Hi ${firstName}, I hope you've enjoyed having me work for you.
I can keep monitoring the market and working on your behalf automatically.

Fi Membership -- $50/month
- $2 per approved match

I'll continuously help you find buyers, find sellers, check pricing, and verify dealer reputation.`;
}

/** Sent once the account's third approval is recorded (spec section 11.4). */
export async function sendConversionMessage(
  pool: Pool,
  canonicalUserId: string,
  isWatchFactsMember: boolean
): Promise<void> {
  const { rows } = await pool.query('SELECT first_name FROM canonical_users WHERE id = $1', [canonicalUserId]);
  const firstName = rows[0]?.first_name ?? 'there';
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: conversionMessage(firstName, isWatchFactsMember),
    buttons: [{ label: 'Keep Fi working for me', action: 'keep-working' }],
  });
}

export async function sendDeclineAcknowledgment(canonicalUserId: string): Promise<void> {
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: 'No problem -- I\'ll still flag matches for you, but approving one going forward requires active Fi billing. Message me "join" anytime you\'re ready.',
  });
}

/**
 * Acknowledges a "join" text or a "Keep Fi working for me" button click.
 * Approval stays locked until an administrator manually enables the account
 * (this MVP's entitlement gate -- see entitlement.service.ts); this only
 * confirms the request was heard, it does not itself unlock anything.
 */
export async function acknowledgeKeepWorking(canonicalUserId: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[audit] account ${canonicalUserId} requested to keep Fi working (awaiting admin entitlement override)`);
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: "Got it -- I've noted that you'd like to keep going. An admin will enable billing on your account shortly, and I'll let you know the moment approvals are unlocked again.",
  });
}

const EXTENSION_REMINDER_TEMPLATE = (daysLeft: number) =>
  `Your Fi monitor is set to expire in ${daysLeft} day(s). Reply "extend" to keep monitoring for another 30 days.`;

export async function sendExtensionReminder(canonicalUserId: string, daysLeft: number): Promise<void> {
  await getMessagingAdapter().send({
    recipientCanonicalUserId: canonicalUserId,
    text: EXTENSION_REMINDER_TEMPLATE(daysLeft),
  });
}
