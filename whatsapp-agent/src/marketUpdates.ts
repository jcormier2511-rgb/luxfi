import crypto from "crypto";
import { config } from "./config";
import { getState } from "./conversation/stateStore";
import { withSchema } from "./postings/db";
import { PostingRow } from "./postings/postingsStore";
import { sendText } from "./whapi/client";
import { getEntitlement } from "./billing/entitlementStore";

export type MarketUpdatePeriod = "morning" | "afternoon";

export interface LocalClock {
  date: string;
  time: string;
}

export interface MarketCounts {
  buyers: number;
  sellers: number;
}

interface DigestWatch extends MarketCounts {
  postingId: number;
  type: "FS" | "WTB";
  brand: string;
  model: string;
  reference: string;
  newMatches: number;
}

interface RecipientRow {
  canonical_user_id: number;
  phone: string;
}

const CLOSED_PAYMENT_STATES = new Set(["blocked", "inactive", "cancelled", "canceled", "closed", "suspended"]);
const LEASE_MINUTES = 10;

/** Intl supplies IANA timezone and DST handling without a process-global TZ mutation. */
export function localClock(at: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

export function duePeriod(
  at: Date,
  timezone: string,
  morningTime: string,
  afternoonTime: string
): { period: MarketUpdatePeriod; localDate: string } | null {
  const clock = localClock(at, timezone);
  if (clock.time === morningTime) return { period: "morning", localDate: clock.date };
  if (clock.time === afternoonTime) return { period: "afternoon", localDate: clock.date };
  return null;
}

/**
 * Deterministic thresholds: fewer than `minimumObservations` total observations is
 * insufficient; otherwise one side must be at least 50% larger AND two observations ahead.
 * Everything else is balanced. This avoids strong conclusions from tiny or near-even sets.
 */
export function marketSentiment(buyers: number, sellers: number, minimumObservations: number): string {
  if (buyers + sellers < minimumObservations) return "Not enough recent activity to determine sentiment.";
  if (buyers - sellers >= 2 && buyers >= sellers * 1.5) return "Demand currently exceeds supply.";
  if (sellers - buyers >= 2 && sellers >= buyers * 1.5) return "Supply currently exceeds demand.";
  return "Supply and demand appear balanced.";
}

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function inferredModel(posting: Pick<PostingRow, "model" | "original_text" | "brand" | "reference">): string {
  if (posting.model.trim()) return posting.model.trim();
  let text = posting.original_text;
  for (const token of [posting.brand, posting.reference, "WTB", "FS", "wanted", "for sale"]) {
    if (token) text = text.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }
  return text.replace(/\b(?:buy|sell|price|usd|hkd|eur)\b|[$€£]\s*[\d,.]+|\b\d+[,.]?\d*\s*k\b/gi, " ").trim().split(/\s+/).slice(0, 4).join(" ");
}

/** Exact reference wins. Brand/model fallback is used only when the subject has no reference. */
export function isRelevant(subject: PostingRow, candidate: PostingRow): boolean {
  const ref = normalized(subject.reference);
  if (ref) return normalized(candidate.reference) === ref;
  const brand = normalized(subject.brand);
  const model = normalized(inferredModel(subject));
  return Boolean(brand && model && normalized(candidate.brand) === brand && normalized(inferredModel(candidate)) === model);
}

function uniqueActor(posting: PostingRow): string {
  if (posting.canonical_user_id !== null) return `user:${posting.canonical_user_id}`;
  const identity = normalized(posting.source_identity || posting.contact_phone || "");
  return identity ? `seller:${identity}` : `listing:${posting.id}`;
}

export function countRelevant(subject: PostingRow, all: PostingRow[], recipientId: number, now = new Date()): MarketCounts {
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  for (const posting of all) {
    if (posting.status !== "active" || new Date(posting.expires_at).getTime() <= now.getTime()) continue;
    if (posting.canonical_user_id === recipientId || !isRelevant(subject, posting)) continue;
    (posting.type === "WTB" ? buyers : sellers).add(uniqueActor(posting));
  }
  return { buyers: buyers.size, sellers: sellers.size };
}

function displayName(watch: DigestWatch): string {
  return [watch.brand, watch.model, watch.reference].filter(Boolean).join(" ") || `request #${watch.postingId}`;
}

export function formatDigest(watches: DigestWatch[], minimumObservations: number): string {
  const sections = watches.map((watch) => {
    const action = watch.type === "WTB" ? "search" : "listing";
    const matchLine = watch.newMatches === 0 ? "No new matches since your last update." : `${watch.newMatches} new match${watch.newMatches === 1 ? "" : "es"} since your last update.`;
    return (
      `Market update for your ${displayName(watch)} ${action}: We've seen ${watch.buyers} active buyers and ` +
      `${watch.sellers} active sellers/listings in the past 15 days. ${marketSentiment(watch.buyers, watch.sellers, minimumObservations)} ${matchLine}`
    );
  });
  return `Your LuxFi market update\n\n${sections.join("\n\n")}`;
}

function signature(watches: DigestWatch[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(watches.map((w) => [w.postingId, w.buyers, w.sellers]))).digest("hex");
}

export function shouldSendDigest(watches: DigestWatch[], previousSignature: string | null, allowUnchanged: boolean): boolean {
  if (allowUnchanged) return watches.length > 0;
  const noActivity = watches.every((w) => w.buyers === 0 && w.sellers === 0 && w.newMatches === 0);
  const unchanged = previousSignature === signature(watches) && watches.every((w) => w.newMatches === 0);
  return watches.length > 0 && !noActivity && !unchanged;
}

async function claimDelivery(userId: number, period: MarketUpdatePeriod, localDate: string, activitySignature: string): Promise<number | null> {
  return withSchema(async (pool) => {
    const result = await pool.query(
      `INSERT INTO market_update_deliveries (canonical_user_id, period, local_date, timezone, status, activity_signature)
       VALUES ($1,$2,$3,$4,'sending',$5)
       ON CONFLICT (canonical_user_id, period, local_date, timezone) DO UPDATE
         SET status='sending', claimed_at=now(), error=NULL, activity_signature=excluded.activity_signature
       WHERE market_update_deliveries.status='failed'
          OR (market_update_deliveries.status='sending' AND market_update_deliveries.claimed_at < now() - ($6 || ' minutes')::interval)
       RETURNING id`,
      [userId, period, localDate, config.marketUpdates.timezone, activitySignature, LEASE_MINUTES]
    );
    return result.rows[0]?.id ?? null;
  });
}

async function markDelivery(id: number, error?: unknown): Promise<void> {
  await withSchema((pool) =>
    error
      ? pool.query(`UPDATE market_update_deliveries SET status='failed', error=$2 WHERE id=$1 AND status='sending'`, [id, String(error)])
      : pool.query(`UPDATE market_update_deliveries SET status='delivered', delivered_at=now(), error=NULL WHERE id=$1 AND status='sending'`, [id])
  );
}

async function buildWatches(userId: number): Promise<{ watches: DigestWatch[]; previousSignature: string | null }> {
  return withSchema(async (pool) => {
    const previous = await pool.query(
      `SELECT delivered_at, activity_signature FROM market_update_deliveries
       WHERE canonical_user_id=$1 AND status='delivered' ORDER BY delivered_at DESC LIMIT 1`,
      [userId]
    );
    const since = previous.rows[0]?.delivered_at ?? new Date(0);
    const [ownResult, allResult] = await Promise.all([
      pool.query<PostingRow>(`SELECT * FROM postings WHERE canonical_user_id=$1 AND status='active' AND expires_at > now() ORDER BY id`, [userId]),
      pool.query<PostingRow>(
        `SELECT * FROM postings WHERE status='active' AND expires_at > now()
         AND COALESCE(renewed_at, created_at) >= now() - interval '15 days'`
      ),
    ]);
    const watches: DigestWatch[] = [];
    for (const own of ownResult.rows) {
      const counts = countRelevant(own, allResult.rows, userId);
      const matches = await pool.query(
        `SELECT count(DISTINCT m.id)::int AS count FROM matches m
         JOIN postings fs ON fs.id=m.fs_posting_id JOIN postings wtb ON wtb.id=m.wtb_posting_id
         WHERE (m.fs_posting_id=$1 OR m.wtb_posting_id=$1) AND m.created_at > $2
           AND fs.status='active' AND fs.expires_at > now() AND wtb.status='active' AND wtb.expires_at > now()`,
        [own.id, since]
      );
      watches.push({
        postingId: own.id,
        type: own.type,
        brand: own.brand,
        model: inferredModel(own),
        reference: own.reference,
        ...counts,
        newMatches: Number(matches.rows[0].count),
      });
    }
    return { watches, previousSignature: previous.rows[0]?.activity_signature ?? null };
  });
}

async function eligibleRecipients(): Promise<RecipientRow[]> {
  return withSchema(async (pool) => {
    const result = await pool.query<RecipientRow>(
      `SELECT DISTINCT p.canonical_user_id, li.identity AS phone
       FROM postings p JOIN linked_identities li ON li.canonical_user_id=p.canonical_user_id AND li.platform='whatsapp'
       WHERE p.status='active' AND p.expires_at > now() AND p.canonical_user_id IS NOT NULL`
    );
    const eligible: RecipientRow[] = [];
    for (const row of result.rows) {
      const entitlement = await getEntitlement(row.phone);
      if (!entitlement.paymentStatus || !CLOSED_PAYMENT_STATES.has(entitlement.paymentStatus.toLowerCase())) eligible.push(row);
    }
    return eligible;
  });
}

export interface MarketUpdateRunResult { sent: number; skipped: number; failed: number }

export async function runMarketUpdates(period: MarketUpdatePeriod, localDate: string): Promise<MarketUpdateRunResult> {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!config.marketUpdates.enabled || !config.whapi.token) return result;
  for (const recipient of await eligibleRecipients()) {
    if (getState(recipient.phone).stage === "opted_out") { result.skipped++; continue; }
    const { watches, previousSignature } = await buildWatches(recipient.canonical_user_id);
    if (watches.length === 0) { result.skipped++; continue; }
    const activitySignature = signature(watches);
    if (!shouldSendDigest(watches, previousSignature, config.marketUpdates.allowUnchanged)) { result.skipped++; continue; }
    const claim = await claimDelivery(recipient.canonical_user_id, period, localDate, activitySignature);
    if (!claim) { result.skipped++; continue; }
    try {
      await sendText(recipient.phone, formatDigest(watches, config.marketUpdates.minimumObservations));
      await markDelivery(claim);
      result.sent++;
    } catch (error) {
      await markDelivery(claim, error);
      result.failed++;
    }
  }
  return result;
}

let schedulerStarted = false;
export function runMarketUpdateScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const tick = async () => {
    const due = duePeriod(new Date(), config.marketUpdates.timezone, config.marketUpdates.morningTime, config.marketUpdates.afternoonTime);
    if (!due) return;
    const outcome = await runMarketUpdates(due.period, due.localDate);
    if (outcome.sent || outcome.failed) console.log(`[market-updates] ${due.period}: ${outcome.sent} sent, ${outcome.skipped} skipped, ${outcome.failed} failed`);
  };
  void tick().catch((err) => console.error("[market-updates] scheduler failed:", err));
  setInterval(() => void tick().catch((err) => console.error("[market-updates] scheduler failed:", err)), 30_000);
}
