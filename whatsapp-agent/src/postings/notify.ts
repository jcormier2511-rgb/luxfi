import { withSchema, withTransaction } from "./db";
import { getOrCreateCanonicalUser } from "./identity";
import { platformForIdentity } from "../channels/identity";
import { PostingRow, getPrimaryImageUrl } from "./postingsStore";
import { getActiveGroupCount } from "./groupActivity";
import { recordNotificationFailure } from "./status";
import { getEntitlement, isPayingMember } from "../billing/entitlementStore";
import { weeklyLimitFor, PlanKey } from "../billing/plans";
import { getWeeklyApprovalCount, recordApprovalEvent, markApprovalRevealed } from "./approvalUsage";
import { sendText, sendBannerImage } from "../channels";
import { config } from "../config";
import { isPostingMonitoringEnabled } from "../admin/store";
import { getListingLimits } from "./listingConfig";
import { saveMoreContext } from "./moreContext";
import { getNotificationPreference, resolveNotifyIdentity, resolveFallbackIdentity } from "./notificationPreferences";
import { consumeFirstContact } from "../lifecycle";
import { getState } from "../conversation/stateStore";

// Same cap groupPublishing.ts's own image+caption send already respects -- a caption over this
// gets silently truncated or rejected depending on the channel, so a match card that runs long
// (a lengthy "In their words" description, several match reasons) falls back to a plain-text
// send with no image rather than risk that.
const MAX_IMAGE_CAPTION_LENGTH = 1000;

/**
 * Sends `message` to a canonical user's preferred channel (see notificationPreferences.ts),
 * returning the identity it actually reached so the caller can record/act on the real delivery
 * channel rather than the one it merely intended. Falls back to another linked identity ONLY on
 * a genuine send failure, and ONLY when the recipient has explicitly opted into fallback
 * delivery — a preferred channel that simply isn't linked yet is resolved (not "fallen back to")
 * by resolveNotifyIdentity itself, before this function is ever called; this is strictly about
 * what happens when an actual delivery attempt throws.
 *
 * `imageUrl`, when given, sends the photo as a real attached image with `message` as its
 * caption instead of a plain text message -- see notifyOneRecipient's own doc comment for when
 * that's actually needed (a listing with no Source: link for WhatsApp/Telegram to auto-preview
 * from). A caption over MAX_IMAGE_CAPTION_LENGTH still degrades to a plain text send rather than
 * risk the channel silently truncating or rejecting it.
 */
async function sendToCanonicalUser(canonicalUserId: number, identity: string, message: string, imageUrl?: string | null): Promise<string> {
  const send = (to: string) => (imageUrl && message.length <= MAX_IMAGE_CAPTION_LENGTH ? sendBannerImage(to, imageUrl, message) : sendText(to, message));
  try {
    await send(identity);
    return identity;
  } catch (err) {
    const { fallbackEnabled } = await getNotificationPreference(canonicalUserId);
    if (!fallbackEnabled) throw err;
    const fallback = await resolveFallbackIdentity(canonicalUserId, identity);
    if (!fallback) throw err;
    await send(fallback);
    return fallback;
  }
}

async function getMatchWithPostings(
  matchId: number
): Promise<{ fs: PostingRow; wtb: PostingRow; reasons: string[] } | null> {
  return withSchema(async (pool) => {
    const matchResult = await pool.query(`SELECT * FROM matches WHERE id=$1`, [matchId]);
    if (matchResult.rows.length === 0) return null;
    const match = matchResult.rows[0];
    const postings = await pool.query<PostingRow>(`SELECT * FROM postings WHERE id = ANY($1::int[])`, [
      [match.fs_posting_id, match.wtb_posting_id],
    ]);
    const fs = postings.rows.find((p) => p.id === match.fs_posting_id);
    const wtb = postings.rows.find((p) => p.id === match.wtb_posting_id);
    if (!fs || !wtb) return null;
    return { fs, wtb, reasons: match.reasons ?? [] };
  });
}

export interface PendingMatchOption {
  matchId: number;
  counterpartName: string;
  brand: string;
  model: string;
  reference: string;
}

/**
 * Every match currently awaiting this user's own approve/pass decision (delivered to them, not
 * yet decided), most recently presented first — feeds server.ts's natural-language decision
 * fallback (ai/decisionInterpreter.ts's interpretPostingsDecision), so a reply like "yes, connect
 * me with the seller" can resolve to a specific matchId the same way "approve <id>" already does.
 * `sourceType`, when given, restricts to matches where THIS recipient's own side of the match
 * (not the counterpart's) was created via that source — e.g. "direct" for
 * tryHandleDirectPostingDecision's narrower scope.
 */
export async function getPendingMatchesForRecipient(
  canonicalUserId: number,
  filter?: { sourceType?: PostingRow["source_type"] }
): Promise<PendingMatchOption[]> {
  const rows = await withSchema((pool) =>
    pool.query<{ match_id: number }>(
      `SELECT match_id FROM (
         SELECT DISTINCT ON (mr.match_id) mr.match_id, mr.notified_at
         FROM match_recipients mr
         WHERE mr.recipient_canonical_user_id = $1 AND mr.decision = 'pending' AND mr.delivered_at IS NOT NULL
         ORDER BY mr.match_id, mr.match_revision DESC
       ) latest
       ORDER BY notified_at DESC, match_id DESC
       LIMIT 20`,
      [canonicalUserId]
    )
  );
  const options: PendingMatchOption[] = [];
  for (const { match_id } of rows.rows) {
    const data = await getMatchWithPostings(match_id);
    if (!data) continue;
    const mine = data.fs.canonical_user_id === canonicalUserId ? data.fs : data.wtb;
    const counterpart = mine === data.fs ? data.wtb : data.fs;
    if (filter?.sourceType && mine.source_type !== filter.sourceType) continue;
    options.push({
      matchId: match_id,
      counterpartName: counterpart.contact_name || "",
      brand: counterpart.brand,
      model: counterpart.model,
      reference: counterpart.reference,
    });
  }
  return options;
}

/**
 * Cosmetic only — the raw digits-only phone stored on a posting (e.g. "12134492911") is never
 * altered for matching/sending, only for how it reads once two sides are actually connected. A
 * North American number (10 digits, or 11 with a leading country-code "1") gets the familiar
 * +1 (XXX) XXX-XXXX form; anything else is shown as a plain "+<digits>" E.164-ish string rather
 * than guessed at without a full phone-number library.
 */
export function formatPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (local) return `+1 (${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
  // Below the shortest real phone number length (7) this isn't phone-shaped at all — e.g. an
  // API-mirrored listing's internal placeholder contact id ("dealer-413") — so it's left alone
  // rather than mangled into a fake-looking "+413".
  return digits.length >= 7 ? `+${digits}` : phone;
}

function watchLabel(posting: PostingRow): string {
  const structured = [posting.brand, posting.model, posting.reference].filter(Boolean).join(" ");
  // Parser-derived brand/model values may be normalized to lowercase. When no reference was
  // captured, retain the original listing's human-readable casing instead of
  // degrading durable approval summaries (for example, "FS Rolex MUTUAL1 ..." -> "rolex").
  if (structured && posting.reference) return structured;
  return posting.original_text.slice(0, 80);
}

export interface MatchPresentation {
  identity?: string;
  brand?: string;
  model?: string;
  reference?: string;
  dial?: string;
  year?: string;
  boxPapers?: string;
  condition?: string;
  price?: string;
  currency?: string;
  location?: string;
  sourceUrl?: string;
  photoUrl?: string;
  /** "Groups active in" signal — omitted (not 0) when unknown, see groupActivity.ts. */
  activeGroupCount?: number;
  /** The counterpart's own free-text description, in their own words -- the structured fields
   *  above are a parsed summary, not necessarily everything they actually said (extra context
   *  like "firm on price" or "can ship" never gets its own structured field). A supplement to
   *  the structured summary, not a replacement for it -- shown as its own line. */
  description?: string;
}

/**
 * A dealer/business name ("ABC Watches") is fine to surface before either side has approved —
 * it's already public. A private WhatsApp user's contact_name falls back to their raw identity
 * when no display name was ever captured (see postingsStore.ts's `senderName || senderIdentity`),
 * and that identity must never be shown pre-approval — the real reported bug this guards against
 * was a buyer's/seller's own phone number appearing in the very first "Match ID#" card, before
 * they had any chance to decide whether to connect at all.
 *
 * A bare WhatsApp identity is digit-only, but Telegram's/SMS's own identity carries a
 * "telegram:"/"sms:" prefix (see channels/identity.ts) — which is letters, not digits, so the
 * original digit-only check alone let a raw Telegram identity ("telegram:5703391972") straight
 * through as though it were a real name. Stripping either known prefix first closes that gap
 * without needing to import channels/identity.ts's own (unexported) prefix constants here.
 */
export function isRealDisplayName(value: string): boolean {
  const withoutPlatformPrefix = value.replace(/^(?:telegram|sms):/i, "");
  return /[a-zA-Z]/.test(withoutPlatformPrefix);
}

// Readability fix (real reported ask: the match card must be clear at a glance for readers of
// any age or attention span, not just for someone parsing a chat/dealer feed by eye) — a chat-
// sourced posting's brand/model are often stored exactly as typed ("rolex", "daytona"), which
// reads as a typo/lowercase-shout in a card meant to look like a clean summary. Reference
// numbers are deliberately left untouched by this — "116500LN" is a code, not a word, and
// title-casing it would corrupt it (see the getWatchLabel-callers below, which never touch it).
function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
const capitalizeFirst = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function presentationFor(posting: PostingRow, photoUrl?: string | null, activeGroupCount?: number): MatchPresentation {
  const rawIdentity = posting.contact_name || posting.source_identity || undefined;
  return {
    identity: rawIdentity && isRealDisplayName(rawIdentity) ? rawIdentity : undefined,
    brand: posting.brand ? titleCase(posting.brand) : undefined,
    model: posting.model ? titleCase(posting.model) : undefined,
    reference: posting.reference || undefined,
    dial: posting.dial ? titleCase(posting.dial) : undefined,
    year: posting.year || undefined,
    boxPapers: posting.box_papers || undefined,
    condition: posting.condition ? capitalizeFirst(posting.condition) : undefined,
    price: posting.price ?? undefined,
    currency: posting.currency || undefined,
    location: posting.location || undefined,
    sourceUrl: posting.detail_url || undefined,
    photoUrl: photoUrl || undefined,
    activeGroupCount: activeGroupCount && activeGroupCount > 0 ? activeGroupCount : undefined,
    description: posting.original_text?.trim() || undefined,
  };
}

export function formatMatchPresentation(matchId: number, roleLabel: string, match: MatchPresentation, heading = "Match", includeIdentity = true): string {
  const lines = [`🎯 ${heading} ${matchId}`];
  // The seller/buyer's own name (already shown right below) is the identifier a person actually
  // recognizes — a raw internal id ("Candidate ID: 9fd0c621-53e6-...") added nothing but noise
  // and was the real reported complaint here.
  //
  // includeIdentity is false for the initial, pre-approval "Match ID#" card (see
  // formatMatchMessage below) -- naming the counterpart before either side has agreed to connect
  // was more than the card needed to say; the "Approved Match" presentation (server.ts's
  // formatApprovalOutcome, called AFTER approveMatch) is the actual reveal and still shows it.
  if (includeIdentity) {
    if (match.identity) lines.push(`${roleLabel}: ${match.identity}`);
    if (match.activeGroupCount) lines.push(`Active in ${match.activeGroupCount} monitored dealer group${match.activeGroupCount === 1 ? "" : "s"}`);
  }
  // Real reported bug: "Watch: rolex daytona 116500ln 116500LN" -- the model field itself
  // sometimes already carries the reference text (a parsing artifact from the original message,
  // e.g. "Daytona 116500ln" stored as the model rather than just "Daytona"), so joining brand +
  // model + reference printed the same reference twice. Stripped out of the model here, case-
  // insensitively, whenever it's already present, rather than fixing every upstream parser that
  // could produce it.
  const modelWithoutReference =
    match.model && match.reference
      ? match.model.replace(new RegExp(match.reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim()
      : match.model;
  const watch = [match.brand, modelWithoutReference, match.reference].filter(Boolean).join(" ");
  // Labeled the same way every other field on this card is -- an unlabeled bare reference
  // ("126505" with no brand/model recorded) otherwise read as a stray floating number with no
  // indication of what it even was.
  if (watch) lines.push(`Watch: ${watch}`);
  if (match.dial) lines.push(`Dial/Color: ${match.dial}`);
  // Real reported ask: readers of any age or attention span must get every field at a glance --
  // a bullet-joined "New • Box/Papers • Pre-owned" line asked the reader to mentally re-attach a
  // label to each part; one labeled line per field removes that step entirely.
  if (match.year) lines.push(`Year: ${match.year}`);
  if (match.boxPapers) lines.push(`Box/Papers: ${match.boxPapers}`);
  if (match.condition) lines.push(`Condition: ${match.condition}`);
  if (match.price) {
    const numeric = Number(match.price);
    const amount = Number.isFinite(numeric) ? numeric.toLocaleString("en-US", { maximumFractionDigits: 2 }) : match.price;
    const formatted = (match.currency || "USD").toUpperCase() === "USD" ? `$${amount}` : `${match.currency} ${amount}`;
    lines.push(`Price: ${formatted}`);
  }
  if (match.location) lines.push(`Location: ${match.location}`);
  if (match.sourceUrl) lines.push(`Source: ${match.sourceUrl}`);
  // No separate "Photo: <url>" text line -- WhatsApp/Telegram already auto-generate a rich link
  // preview (image + title) from the Source: URL right above whenever one is present, so a
  // second, raw-filename mention of the same photo was pure redundant text, not new information.
  // Their own words, not just the parsed fields above -- extra context (firm on price, can
  // ship, etc.) never gets its own structured field. Trimmed to keep the card skimmable rather
  // than reprinting a long raw message in full. Quoted so it visually reads as someone else's
  // sentence, not as more of Fi's own structured summary.
  if (match.description) {
    const trimmed = match.description.length > 140 ? `${match.description.slice(0, 140)}…` : match.description;
    lines.push(`💬 In their words: "${trimmed}"`);
  }
  return lines.join("\n");
}

// Appended once, after the match card, on someone's genuine first-ever contact with Fi (see
// consumeFirstContact in notifyOneRecipient below) -- never a full onboarding/capabilities dump,
// just enough context for who's messaging them and how to learn more on their own terms.
const FIRST_CONTACT_INTRO =
  '👋 I\'m Fi, your personal luxury concierge — this is the kind of match I find automatically, day and night. Reply "help" to see everything I can do.';

/**
 * Spec §9.1's Match ID# format, minus the "Fi Intelligence" block (dealer
 * reputation/price trend/market range/authenticity) — no data source for any of that exists,
 * same honest omission the v3 flow's Match Card already makes. `matchId` is embedded in the
 * reply instructions since notifications are server-pushed, not part of a synchronous
 * request/response turn the way the v3 flow's numbered list is — the recipient needs a way
 * to say which match they mean.
 */
export function formatMatchMessage(
  matchId: number,
  self: PostingRow,
  counterpart: PostingRow,
  reasons: string[],
  imageUrl: string | null,
  activeGroupCount?: number
): string {
  const roleLabel = self.type === "FS" ? "Buyer" : "Seller";
  // An exact reference match (scoreMatch's highest-confidence branch, always its first reason —
  // see matching.ts) is self-explanatory: it's the same watch, full stop. Spelling that out in a
  // bullet list only repeats what the Watch/price/location lines above already show. The "why"
  // only earns its place on a LOOSE match (same-brand-only, or no reference/brand stated at all),
  // where it isn't obvious from the fields alone why this candidate was surfaced.
  const isLooseMatch = !reasons[0]?.startsWith("Exact reference match");
  return (
    // Keep the established notification discriminator as well as the numeric ID. Besides being
    // useful to people scanning a chat, downstream channel consumers and the PR #20 regression
    // suite intentionally recognize automatic notifications by the "Match ID#" heading.
    formatMatchPresentation(matchId, roleLabel, presentationFor(counterpart, imageUrl, activeGroupCount), "Match ID#", false) +
    (isLooseMatch && reasons.length ? `\n\n✅ Why it's a good match:\n${reasons.map((r) => `• ${r}`).join("\n")}` : "") +
    // "pass" is deliberately not mentioned as its own step -- doing nothing already has the
    // exact same effect (this candidate still counts toward the per-listing cap either way, see
    // notifyOneRecipient), so telling someone to reply just to decline was an extra step with no
    // actual purpose. "approve" is the only reply that does anything, so it's the only one asked
    // for; ignoring a match a person isn't interested in stays completely safe.
    `\n\n📞 Reply "approve ${matchId}" to get their contact info.\nNot for you? No need to reply — just leave it.` +
    // Emoji-only styling (no *bold*/_italic_ markdown) is deliberate -- WhatsApp renders that
    // syntax natively but channels/telegram.ts's sendText sets no parse_mode, so Telegram would
    // show literal asterisks/underscores instead of formatting. Plain text + emoji renders
    // identically on both channels without needing per-platform escaping.
    `\n\n✅ Already found what you need? Reply "listings" to close that request so I stop sending you new matches for it.`
  );
}

function groupMatchMessage(matchId:number,self:PostingRow,counterpart:PostingRow,reasons:string[],imageUrl:string|null,activeGroupCount?:number):string{
  const watch=[self.brand,self.model,self.reference].filter(Boolean).join(" ")||self.original_text.slice(0,80);
  const intro=self.type==="WTB"?`Hi — I’m Fi from WatchFacts. I saw your request for ${watch} and found a potential match.`:`Hi — I’m Fi from WatchFacts. I saw you’re selling ${watch} and found a potential buyer.`;
  const more=self.type==="WTB"?`I can also show you other available ${watch} listings on WatchFacts. Reply MORE.`:`I can also show you other relevant buyer opportunities on WatchFacts. Reply MORE.`;
  return `${intro}\n\n${formatMatchMessage(matchId,self,counterpart,reasons,imageUrl,activeGroupCount)}\n\n${more}`;
}

/**
 * Notifies one canonical user about one match at one revision, idempotently: the INSERT ...
 * ON CONFLICT DO NOTHING on (match_id, recipient, revision) is the actual dedup — if it
 * returns no row, this exact notification already went out (a duplicate webhook delivery, a
 * re-run reconciliation sweep, etc.), so no second message is sent. The WhatsApp send itself
 * happens outside any DB transaction — a network call has no business holding a Postgres
 * transaction open.
 */
async function notifyOneRecipient(
  matchId: number,
  recipientCanonicalUserId: number,
  revision: number,
  self: PostingRow,
  counterpart: PostingRow,
  reasons: string[]
): Promise<void> {
  // Checked at send time, not just once at ingestion — a group removed from
  // V4_ALLOWED_CHAT_IDS (or the master flag turned off) after this posting was already stored
  // must stop it from generating notifications immediately. Checked BEFORE the claim below so
  // nothing gets marked "notified" for a message that was never actually sent — if the group
  // becomes allowed again later, this stays retryable rather than permanently skipped.
  if (!await isPostingMonitoringEnabled(self)) return;

  // A paying counterpart's listing always reaches an interested recipient -- their delivery is
  // exempt from this cap entirely (never blocked by it, and never counted toward it), rather
  // than just being prioritized into the same limited slots a free-tier counterpart competes
  // for. That's what actually stops a paying member from ever being "shut out," and it also
  // protects a free-tier competitor's own shot at those slots -- a paying delivery never
  // consumes one. Checked live against the counterpart's CURRENT plan, never cached: the
  // instant a membership lapses, the very next match this account is part of goes back to
  // competing for capped slots like anyone else.
  const counterpartPaying = await isPayingMember(counterpart.contact_phone);
  if (!counterpartPaying) {
    // A paying recipient (the listing owner being notified, not the counterpart) gets a much
    // higher cap on their OWN listing instead of the same fixed default -- more of their
    // matches get through, without touching how free-tier competitors are capped.
    const { maxMatchesPerListing, maxMatchesPerListingPaying } = await getListingLimits();
    const recipientPaying = await isPayingMember(self.contact_phone);
    const cap = recipientPaying ? maxMatchesPerListingPaying : maxMatchesPerListing;
    const shown = await withSchema(pool=>pool.query(`SELECT count(*)::int n FROM match_recipients mr JOIN matches m ON m.id=mr.match_id WHERE mr.recipient_canonical_user_id=$1 AND mr.delivered_at IS NOT NULL AND mr.counterpart_was_paying=FALSE AND ($2=m.fs_posting_id OR $2=m.wtb_posting_id)`,[recipientCanonicalUserId,self.id]));
    if(Number(shown.rows[0]?.n??0)>=cap){
      // Keep durable ownership/decision state without claiming this candidate was presented.
      // Reconciliation can promote it later if the administrator raises the limit.
      await withSchema(pool=>pool.query(`INSERT INTO match_recipients(match_id,recipient_canonical_user_id,match_revision,counterpart_was_paying) VALUES($1,$2,$3,FALSE) ON CONFLICT(match_id,recipient_canonical_user_id,match_revision) DO NOTHING`,[matchId,recipientCanonicalUserId,revision]));
      return;
    }
  }

  const claimed = await withSchema((pool) =>
    pool.query(
      `INSERT INTO match_recipients (match_id, recipient_canonical_user_id, match_revision, notified_at, counterpart_was_paying)
       VALUES ($1,$2,$3, now(), $4)
       ON CONFLICT (match_id, recipient_canonical_user_id, match_revision) DO UPDATE
         SET notified_at=now()
         WHERE match_recipients.delivered_at IS NULL AND match_recipients.decision='pending'
       RETURNING id`,
      [matchId, recipientCanonicalUserId, revision, counterpartPaying]
    )
  );
  if (claimed.rows.length === 0) return; // already notified — dedup

  const phone = await resolveNotifyIdentity(recipientCanonicalUserId);
  if (!phone) return; // e.g. the API-mirrored FS side has no linked identity to notify at all

  // Real reported gap: STOP (conversation/flow.ts's opt-out handling) only ever stops Fi from
  // REPLYING to that phone -- this async, match-triggered notification path never checked it at
  // all, so someone who explicitly opted out could still receive automatic match pushes. Checked
  // here, not earlier, so it still counts as "claimed" above (no duplicate later) but never
  // marked delivered -- exactly the same retryable shape as the `!phone` case just above, so if
  // they ever reply START again, the next notification pass finds this posting still active and
  // delivers normally, rather than requiring a brand-new match to ever reach them again.
  if (getState(phone).stage === "opted_out") return;

  // Best-effort only — a listing with no captured image (most chat posts today, since
  // downloading/durable-storing WhatsApp media is still out of scope, see db.ts) just sends the
  // plain text card with no photo, same honest omission pattern as the missing "Fi Intelligence"
  // block. Deliberately its own try/catch, separate from the sendText one below: an image lookup
  // failure (missing row, a transient DB hiccup) must fall back to a text-only match card,
  // never propagate out of here — this runs inside runImmediateMatch's per-candidate loop
  // (see matching.ts), so an uncaught throw here would silently abort matching against every
  // remaining candidate in that same sync/ingestion pass, not just skip one photo.
  let imageUrl: string | null = null;
  try {
    imageUrl = await getPrimaryImageUrl(counterpart.id);
  } catch (err) {
    console.error(`[postings] image lookup failed for posting ${counterpart.id} (falling back to text-only):`, err);
  }
  // Same best-effort isolation for the "groups active in" line: a failed count just leaves
  // the line out (the card omits it at 0 anyway) — it must never abort delivery.
  let activeGroupCount: number | undefined;
  try {
    if (counterpart.canonical_user_id) activeGroupCount = await getActiveGroupCount(counterpart.canonical_user_id);
  } catch (err) {
    console.error(`[postings] active group count failed for user ${counterpart.canonical_user_id} (omitting line):`, err);
  }

  try {
    const fromGroup=self.source_type==="chat"&&Boolean(self.source_chat_id);
    let message = fromGroup?groupMatchMessage(matchId,self,counterpart,reasons,imageUrl,activeGroupCount):formatMatchMessage(matchId, self, counterpart, reasons, imageUrl, activeGroupCount);
    // A match notification is a pure proactive send with no onboarding framing of its own (see
    // consumeFirstContact's doc comment) -- someone whose first-ever contact with Fi is a cold
    // match card (e.g. only ever posted in a monitored group, never messaged Fi directly) would
    // otherwise see this content with zero context for who's messaging them or why. Appended
    // AFTER the match, not before -- leading with the actual value reads better than a generic
    // intro landing first. Exactly once per identity, ever, regardless of how many matches follow.
    if (await consumeFirstContact(phone)) message += `\n\n—\n${FIRST_CONTACT_INTRO}`;
    // A listing with its own detail_url (a WatchFacts dealer-feed link) already gets a rich
    // preview -- image included -- for free from the Source: line in `message`; sending the
    // SAME photo again as a second attached image would be a duplicate. A private/direct-
    // sourced listing has no such link (see notify.ts's formatMatchPresentation, which no
    // longer prints a raw "Photo: <url>" text line either), so that's the one case the photo
    // needs to actually be attached for the counterpart to see it at all.
    const attachImage = !counterpart.detail_url ? imageUrl : null;
    const deliveredTo = await sendToCanonicalUser(recipientCanonicalUserId, phone, message, attachImage);
    await withSchema(pool=>pool.query(`UPDATE match_recipients SET delivered_at=now() WHERE match_id=$1 AND recipient_canonical_user_id=$2 AND match_revision=$3`,[matchId,recipientCanonicalUserId,revision]));
    if(fromGroup)await saveMoreContext(recipientCanonicalUserId,platformForIdentity(deliveredTo),self,counterpart,matchId);
  } catch (err) {
    console.error(`[postings] failed to deliver match notification ${matchId} to ${phone}:`, err);
    await withSchema(pool=>pool.query(`DELETE FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2 AND match_revision=$3 AND decision='pending'`,[matchId,recipientCanonicalUserId,revision]));
    await recordNotificationFailure((err as Error).message);
  }
}

/** Notifies both sides of a match that have a canonical WhatsApp user (an API-sourced FS listing has none). */
export async function notifyMatch(matchId: number, revision: number): Promise<void> {
  const data = await getMatchWithPostings(matchId);
  if (!data) return;
  const { fs, wtb, reasons } = data;

  if (fs.canonical_user_id !== null) {
    await notifyOneRecipient(matchId, fs.canonical_user_id, revision, fs, wtb, reasons);
  }
  if (wtb.canonical_user_id !== null) {
    await notifyOneRecipient(matchId, wtb.canonical_user_id, revision, wtb, fs, reasons);
  }
}

export async function passMatch(matchId: number, phone: string): Promise<"passed" | "already_decided" | "invalid"> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  return withSchema(async (pool) => {
    const matchRow = await pool.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
    if (matchRow.rows.length === 0) return "invalid";
    const { fs_posting_id, wtb_posting_id } = matchRow.rows[0];
    // Checked at decision time, not just at ingestion — a posting from a group that's no
    // longer allowed must not accept a pass decision either.
    if (!(await isOwnPostingChatEnabled(pool, fs_posting_id, wtb_posting_id, canonicalUserId))) return "invalid";

    const recipientResult = await pool.query(
      `SELECT * FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2 ORDER BY match_revision DESC LIMIT 1`,
      [matchId, canonicalUserId]
    );
    if (recipientResult.rows.length === 0) return "invalid";
    const recipient = recipientResult.rows[0];
    if (recipient.decision !== "pending") return "already_decided";
    await pool.query(`UPDATE match_recipients SET decision='passed', decided_at=now() WHERE id=$1`, [recipient.id]);
    return "passed";
  });
}

export interface ApprovalOutcome {
  status: "approved" | "pending_confirmation" | "locked" | "invalid" | "posting_closed";
  counterpart?: { name: string; phone: string };
  match?: MatchPresentation;
  /** Only set when status is "locked" — which of the two lock reasons this is, so the caller
   *  can show the right message (see server.ts's formatApprovalOutcome). */
  lockReason?: "no_plan" | "weekly_cap";
  plan?: PlanKey;
  weeklyLimit?: number;
}

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface MatchRecipientRow {
  id: number;
  decision: "pending" | "approved" | "passed";
  connected_at: string | null;
}

/**
 * Decision-time allowlist gate (spec: apply V4_ALLOWED_CHAT_IDS at approve/pass time, not
 * just at ingestion) — resolves whichever of the match's two postings belongs to the
 * requesting user and checks whether it's still chat-enabled. A posting that isn't
 * resolvable to either side (shouldn't happen for a real recipient) is never blocked on this
 * check alone.
 */
async function isOwnPostingChatEnabled(
  client: QueryClient,
  fsPostingId: number,
  wtbPostingId: number,
  canonicalUserId: number
): Promise<boolean> {
  const result = await client.query(`SELECT canonical_user_id, source_type, source_chat_id FROM postings WHERE id = ANY($1::int[])`, [
    [fsPostingId, wtbPostingId],
  ]);
  const mine = result.rows.find((r) => r.canonical_user_id === canonicalUserId);
  if (!mine) return true;
  return isPostingMonitoringEnabled(mine);
}

/** `lock` uses FOR UPDATE — only ever set true for the CALLER's own row, never the counterpart's, to avoid two concurrent approvals on the same match deadlocking on each other's rows. */
async function getRecipientRow(
  client: QueryClient,
  matchId: number,
  canonicalUserId: number,
  lock: boolean
): Promise<MatchRecipientRow | null> {
  const result = await client.query(
    `SELECT * FROM match_recipients WHERE match_id=$1 AND recipient_canonical_user_id=$2
     ORDER BY match_revision DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [matchId, canonicalUserId]
  );
  return result.rows[0] ?? null;
}

/**
 * Fi Build Spec v4 §9/§11 — atomic, idempotent approval transaction. Approving reveals the
 * counterpart's contact info to the approver immediately, in the same reply — it does not wait
 * for the counterpart to also approve. (Real reported ask: the earlier mutual-confirmation
 * design left the FIRST approver seeing nothing until the other side separately approved too,
 * which read as "approve did nothing." Each side's own approval now stands entirely on its
 * own — whoever approves sees the other side right away, and nothing here pushes a person's own
 * contact info to the counterpart on their behalf; the counterpart still only sees it once
 * THEY approve.)
 *
 * - matches.connected_at is the match-level "connected" record; match_recipients.connected_at
 *   is the per-side idempotency claim — a duplicate click, or a second approval from the same
 *   side, can never re-run this twice for one side.
 * - A posting that already hit its 5-approved-match cap (status != 'active') refuses any
 *   further approval outright, even against a match that was created/surfaced before it
 *   closed.
 *
 * The first 3 account-level approvals are complimentary ($0 ledger entries). After that, this
 * shares the SAME gating logic v3's on-demand flow uses (postings/approvalUsage.ts) — no plan
 * assigned locks further approvals outright; a tier1/tier2 plan allows up to its weekly cap
 * (rolling 7 days); tier3 or the legacy admin override (account_entitlements.manual_override_
 * enabled) is unlimited. No payment processor exists, so every ledger entry is $0 — a real
 * charge is never attempted; an admin assigns the plan (see src/billing/entitlementStore.ts).
 */
export async function approveMatch(matchId: number, phone: string): Promise<ApprovalOutcome> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const entitlement = await getEntitlement(phone);

  return withTransaction(async (client) => {
    const matchRow = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
    if (matchRow.rows.length === 0) return { status: "invalid" as const };
    const { fs_posting_id, wtb_posting_id } = matchRow.rows[0];

    // Checked at decision time, not just at ingestion — a posting from a group that's no
    // longer allowed (or with the master flag now off) must not accept an approve decision.
    if (!(await isOwnPostingChatEnabled(client, fs_posting_id, wtb_posting_id, canonicalUserId))) {
      return { status: "invalid" as const };
    }

    const userResult = await client.query(`SELECT * FROM canonical_users WHERE id=$1 FOR UPDATE`, [canonicalUserId]);
    const user = userResult.rows[0];

    const recipient = await getRecipientRow(client, matchId, canonicalUserId, true);
    if (!recipient) return { status: "invalid" as const };

    const ownPostingId = await resolveOwnPostingId(client, fs_posting_id, wtb_posting_id, canonicalUserId);

    if (recipient.decision !== "approved") {
      // The closed-posting guard only applies to a genuinely NEW approval — re-clicking
      // "approve" on a match this side already approved before the posting closed must still
      // work idempotently (same info, no new count), since it isn't a 6th approval at all.
      if (ownPostingId !== null) {
        const ownPosting = await client.query(`SELECT status FROM postings WHERE id=$1 FOR UPDATE`, [ownPostingId]);
        if (ownPosting.rows[0]?.status !== "active") {
          return { status: "posting_closed" as const };
        }
      }

      // Must match approvalUsage.ts's getApprovalUsage formula exactly -- a returning user
      // granted bonus tasks via the Fi-returning campaign (fi_returning_promotions) but already
      // past their 3 lifetime approvals still gets a complimentary approval here too, the same
      // as the v3 on-demand flow already grants via evaluateApprovalGate.
      const promo = await client.query(`SELECT tasks_granted, tasks_used FROM fi_returning_promotions WHERE canonical_user_id=$1`, [canonicalUserId]);
      const promotionalTasksRemaining = promo.rows[0] ? promo.rows[0].tasks_granted - promo.rows[0].tasks_used : 0;
      const isComplimentary = user.total_approved_count < config.trial.maxApprovedMatches || promotionalTasksRemaining > 0;
      if (!isComplimentary) {
        const weeklyLimit = weeklyLimitFor(entitlement);
        if (weeklyLimit === 0) {
          return { status: "locked" as const, lockReason: "no_plan" as const };
        }
        if (weeklyLimit !== null) {
          const weeklyUsed = await getWeeklyApprovalCount(client, canonicalUserId);
          if (weeklyUsed >= weeklyLimit) {
            return { status: "locked" as const, lockReason: "weekly_cap" as const, plan: entitlement.plan as PlanKey, weeklyLimit };
          }
        }
      }

      // Idempotency key: match_id + approving_canonical_user_id. A duplicate/racing click hits
      // this conflict and is treated as a no-op rather than double-counting.
      const fsPostingForDescription = await client.query(`SELECT * FROM postings WHERE id=$1`, [fs_posting_id]);
      const listingDescription = watchLabel(fsPostingForDescription.rows[0]);
      const approved = await recordApprovalEvent(client, canonicalUserId, matchId, isComplimentary, listingDescription);
      if (approved) {
        if (ownPostingId !== null) {
          const updated = await client.query(
            `UPDATE postings SET approved_match_count = approved_match_count + 1, updated_at=now()
             WHERE id=$1 RETURNING approved_match_count`,
            [ownPostingId]
          );
          if (updated.rows[0].approved_match_count >= 5) {
            await client.query(`UPDATE postings SET status='completed_match_limit' WHERE id=$1`, [ownPostingId]);
          }
        }

        await client.query(`UPDATE match_recipients SET decision='approved', decided_at=now() WHERE id=$1`, [recipient.id]);
      }
      // else: lost a race to a concurrent duplicate click on the same match+user — fall
      // through and re-derive current state below, with no double side effects.
    }

    const counterpart = await getCounterpartContact(client, matchId, canonicalUserId);
    const counterpartPhoto = await client.query(`SELECT source_url FROM posting_images WHERE posting_id=$1 ORDER BY is_primary DESC, display_order ASC LIMIT 1`, [counterpart.posting.id]);
    const presentation = presentationFor(counterpart.posting, counterpartPhoto.rows[0]?.source_url);

    // Reveal to me now — no waiting on the counterpart's own decision. Both UPDATEs are
    // idempotency claims (WHERE ... IS NULL): harmless no-ops on a duplicate click.
    await client.query(`UPDATE match_recipients SET connected_at = now() WHERE id=$1 AND connected_at IS NULL`, [recipient.id]);
    await client.query(`UPDATE matches SET connected_at = now() WHERE id=$1 AND connected_at IS NULL`, [matchId]);
    // Exactly the moment my own "my approved matches" summary (approvalUsage.ts) becomes
    // allowed to show this counterpart — never before.
    await markApprovalRevealed(client, canonicalUserId, matchId, { name: counterpart.name, phone: counterpart.phone });

    return { status: "approved" as const, counterpart: { name: counterpart.name, phone: counterpart.phone }, match: presentation };
  });
}

async function resolveOwnPostingId(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { id: number; canonical_user_id: number | null }[] }> },
  fsPostingId: number,
  wtbPostingId: number,
  canonicalUserId: number
): Promise<number | null> {
  const result = await client.query(`SELECT id, canonical_user_id FROM postings WHERE id = ANY($1::int[])`, [
    [fsPostingId, wtbPostingId],
  ]);
  const mine = result.rows.find((r) => r.canonical_user_id === canonicalUserId);
  return mine ? mine.id : null;
}

async function getCounterpartContact(
  client: {
    query: (
      sql: string,
      params: unknown[]
    ) => Promise<{ rows: PostingRow[] }>;
  },
  matchId: number,
  approvingCanonicalUserId: number
): Promise<{ name: string; phone: string; canonicalUserId: number | null; posting: PostingRow }> {
  const matchResult = await client.query(`SELECT fs_posting_id, wtb_posting_id FROM matches WHERE id=$1`, [matchId]);
  const { fs_posting_id, wtb_posting_id } = matchResult.rows[0] as unknown as { fs_posting_id: number; wtb_posting_id: number };
  const postings = await client.query(
    `SELECT * FROM postings WHERE id = ANY($1::int[])`,
    [[fs_posting_id, wtb_posting_id]]
  );
  const mine = postings.rows.find((r) => r.canonical_user_id === approvingCanonicalUserId);
  const other = postings.rows.find((r) => r.id !== mine?.id) ?? postings.rows[0];
  return { name: other.contact_name, phone: other.contact_phone, canonicalUserId: other.canonical_user_id, posting: other };
}
