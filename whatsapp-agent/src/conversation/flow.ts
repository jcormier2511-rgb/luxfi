import { config, isAiChatEnabled, isAiMatchingEnabledForPhone } from "../config";
import { Contact, ConversationState, ItemRequest, InventoryListing, SearchPreferences, MatchDecision, PendingSellIntake, PendingBuyIntake } from "../types";
import { findMatchesHybrid, formatMatchCard, formatMatchApproved, attachPriceSignals, attachCurrencyDisplay, CurrencyDisplay } from "../matching/engine";
import { PriceSignal } from "../matching/priceSignal";
import { requestPhotosForMatch } from "../matching/photoRequests";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";
import { getState, saveState } from "./stateStore";
import { parsePriceRange, parseFreeformPreference } from "./preferences";
import { recordBillingRequested, getEntitlement, createCheckoutSession, findLatestCheckoutAttempt } from "../billing/entitlementStore";
import { MEMBERSHIP_PLANS, PlanKey } from "../billing/plans";
import { isAuthorizeNetConfigured } from "../billing/authorizeNet";
import { getApprovalUsage, evaluateApprovalGate, recordApprovalEventForPhone, getApprovedMatchesSummary } from "../postings/approvalUsage";
import { getOrCreateCanonicalUser } from "../postings/identity";
import { platformForIdentity, smsIdentity, ChannelPlatform } from "../channels/identity";
import {
  getNotificationPreference, setPreferredChannel, getLinkedIdentities, linkIdentity,
  createPendingIdentityLink, consumePendingIdentityLink, channelLabel,
} from "../postings/notificationPreferences";
import { getActivePostingsForUser, getManageablePostingsForUser, setPostingManagementStatus, updatePostingField, PostingRow } from "../postings/postingsStore";
import { runImmediateMatch } from "../postings/matching";
import { logSearchRequest } from "../postings/analytics";
import { interpretQuery, toSearchPreferences } from "../ai/queryInterpreter";
import { interpretDecision } from "../ai/decisionInterpreter";
import { generateGeneralChatReply } from "../ai/chatReply";
import { detectCurrency, convertMoneyToUsd, CurrencyCode } from "../matching/currency";

import { extractIntent, isConfidentIntent } from "../ai/intentExtractor";
import { CURRENCY_CODES } from "../fx/currency";
import { extractReference, containsKnownBrand, normalizePriceShorthand, normalizeText, referencesMatch, canonicalizeReference, normalizeReference, splitLeadingBrand, INTENT_TOKENS, isOnlyNonModelLanguage, identityForReference } from "../postings/normalize";
import { getActiveListings, upsertListings } from "../watchfacts/inventoryDb";
import { ingestDirectSellPosting, ingestDirectBuyPosting } from "../postings/ingest";
import { MORE_COMMAND, formatMoreResults } from "../postings/moreContext";
import { formatMarketPulse, getScopedMarketPulse, getNetworkMarketSnapshot, formatNetworkMarketSnapshot } from "../postings/marketPulse";

// "cancel" used to be an opt-out word here — it's now its OWN deterministic command (clears the
// current pending match/interview without unsubscribing, see handleCancelCommand below), per
// the routing fix: approve/pass/photos/cancel/status/help must all be recognized, distinct
// commands, checked before anything else ever runs.
const OPT_OUT_WORDS = ["stop", "unsubscribe", "opt out", "optout"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isOptOut(text: string): boolean {
  const n = normalize(text);
  if (/^stop\s+listing\s+\d+\s*[?.!]*$/i.test(text.trim())) return false;
  return OPT_OUT_WORDS.some((w) => n === w || n.startsWith(`${w} `));
}

const BUY_KEYWORDS = /\b(buy|buying|wtb|looking for|want|need|iso|find me|in search of)\b/i;
const SELL_KEYWORDS = /\b(sell|selling|fs|for sale|i have|wts)\b/i;

/**
 * A message whose OPENING clause is unambiguously a fresh WTB request — including the natural
 * "I want to buy X" phrasing, not just a bare "WTB"/"buy" prefix. Live-reported: with a WTB
 * draft already open, "i want to buy a rolex daytona" matched neither this nor any field
 * correction, and got swallowed by the draft's answer handler ("I kept your request draft
 * open.") instead of restating it, because the old check anchored on "WTB|buy|want to buy"
 * directly — the leading "i " defeated it.
 *
 * Deliberately narrower than BUY_KEYWORDS (which matches a bare "want"/"need" ANYWHERE in the
 * text): a bare "want"/"need" not immediately followed by "to buy"/"to" is also how a real
 * mid-interview ANSWER reads ("I want the black dial", "I need it in the US"), and must never
 * reset the very draft it's answering.
 */
// "I'm" has no space before the apostrophe. The earlier form, i\s+(?:'m\s+)?, demanded one, so
// every sentence opening "I'm looking for…" — the most common natural opener there is — failed
// this gate and was swallowed by an open draft's answer handler. That was the Stage 1 live
// failure's contamination half.
const FRESH_BUY_LEAD_IN = /^\s*(?:i(?:\s+am|\s*['’]m)?\s+)?(?:would\s+like\s+to\s+|want(?:ing)?\s+to\s+|need\s+to\s+)?(?:wtb|buy(?:ing)?|looking\s+for|in\s+search\s+of|iso|find\s+me)\b/i;

/**
 * Is this message a NEW buy request, rather than an answer to the open draft's question?
 *
 * The lead-in regex above is the fast safeguard. The semantic rule beside it is what the
 * product promises: a message that states buy intent AND names a product of its own (a maker
 * or a reference) is a request, however it is phrased. An interview answer never has both —
 * "rolex daytona" (which model?) has no intent word; "I want the black dial" / "I need it in
 * the US" have intent but name no product — so answers still reach the draft they answer.
 */
function isFreshBuyRequest(text: string): boolean {
  if (FRESH_BUY_LEAD_IN.test(text)) return true;
  return parseItemRequests(text).some((item) => item.action === "buy" && carriesProductIdentity(item.query));
}

// Same shape as FRESH_BUY_LEAD_IN, sell-side keywords.
const FRESH_SELL_LEAD_IN = /^\s*(?:i(?:\s+am|\s*['’]m)?\s+)?(?:would\s+like\s+to\s+|want(?:ing)?\s+to\s+|need\s+to\s+)?(?:fs|wts|for\s+sale|sell(?:ing)?|i\s+have)\b/i;

/**
 * Is this message a NEW sell request, rather than an answer to the open draft's question? Same
 * two-part rule as isFreshBuyRequest. Real reported bug this fixes: the router used to check
 * only an anchored `/^(?:FS|WTS|for sale|sell(?:ing)?)\b/` — which requires the message to
 * literally START with one of those words — so "I want to sell a rolex 116500 black dial or
 * 38000 preowned" (sell intent, but prefixed with "I want to") never matched. Both this and an
 * abandoned draft stuck at the photo step (see channels/telegram.ts's document fix) meant the
 * new, complete request silently got treated as a scoped EDIT to the stale draft instead of a
 * fresh one — corrupting it with a garbled model and carrying over a stale, already-superseded
 * price.
 */
function isFreshSellRequest(text: string): boolean {
  if (FRESH_SELL_LEAD_IN.test(text)) return true;
  return parseItemRequests(text).some((item) => item.action === "sell" && carriesProductIdentity(item.query));
}

// Tried longest/most-specific first, in a loop, so a compound lead-in ("I want to buy a...")
// gets fully consumed rather than just its first word — the real reported bug this fixes: the
// old single-pass regex only ever stripped ONE leading keyword, so "want to buy a patek 5712G"
// (leading "I" blocks the old anchor entirely, or leading "want to" leaves "to buy a..." behind
// either way) ended up storing "to buy a patek 5712G" as the search text/reference instead of
// "patek 5712G".
const LEADING_PHRASES = [
  "i would like to",
  "i'm looking for",
  "im looking for",
  "i am looking for",
  "in search of",
  "looking for",
  "i want to",
  "i want",
  "want to",
  "i need to",
  "need to",
  "i need",
  "need a",
  "find me",
  "i have",
  "iso",
  "wtb",
  "wts",
  "for sale",
  "fs",
  "buying",
  "buy",
  "selling",
  "sell",
  "want",
  "need",
];

// INTENT_TOKENS / isOnlyIntentLanguage live in postings/normalize.ts so intake and posting
// persistence reject the same leftover lead-in language — see the note on their definition.
// Real reported bug: "WTB i want ot buy a rolex, ..." matches no entry in LEADING_PHRASES as one
// phrase ("i want to" doesn't cover "i want ot"), so the lead-in survived stripping and "ot buy
// a" was stored as the watch's model.

/** Strips a leading intent phrase (any combination/order of the above), then a leftover leading
 *  filler word ("to"/"a"/"an"/"the") — never touches anything after the actual item description
 *  starts. Exported for the legacy-parser regression tests. */
export function stripLeadingIntent(text: string): string {
  let s = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of LEADING_PHRASES) {
      const re = new RegExp(`^${phrase.replace(/\s+/g, "\\s+")}\\b[\\s:,-]*`, "i");
      const stripped = s.replace(re, "");
      if (stripped !== s) {
        s = stripped.trim();
        changed = true;
        break;
      }
    }
    if (changed) continue;
    // The phrase list is exhausted but the message may still open with intent language the
    // list can't express as a fixed phrase (a typo, or an unusual word order). Drop leading
    // words one at a time while they're pure intent language, and stop at the first token that
    // isn't — so nothing from the actual item description onward is ever touched.
    const leading = s.match(/^([A-Za-z'\u2019]+)\b[\s:,-]*/);
    if (leading && INTENT_TOKENS.has(leading[1].toLowerCase().replace(/\u2019/g, "'"))) {
      s = s.slice(leading[0].length).trim();
      changed = true;
    }
  }
  return s.replace(/^(a|an|the)\s+/i, "").trim();
}

function classify(segment: string): ItemRequest | null {
  const text = segment.trim();
  if (!text) return null;
  // Require an explicit buy/sell signal — otherwise plain chatter ("hi", "ok", "thanks")
  // would get misread as an item request.
  let action: ItemRequest["action"];
  if (SELL_KEYWORDS.test(text)) action = "sell";
  else if (BUY_KEYWORDS.test(text)) action = "buy";
  else return null;
  const query = stripLeadingIntent(text);
  if (!query) return null;
  return { action, query };
}

/**
 * A segment that names a product of its OWN — a known maker, or a watch reference. Only such a
 * segment can be a separate item. Everything else ("black dial", "pre-owned", "I'm in Miami",
 * "don't want to spend more than $25,000") is a clause continuing the item before it.
 */
function carriesProductIdentity(segment: string): boolean {
  return containsKnownBrand(segment) || extractReference(segment) !== null;
}

/**
 * Splits a message into the distinct products it asks about.
 *
 * Commas, semicolons, line breaks and "and" are where a SECOND product would start — but they
 * are also how one product's details are strung together, and how ordinary sentences join
 * clauses. The live failure: "…116500LN with a black dial. I'm in Miami and don't want to spend
 * more than $25,000" split at "and", and "don't WANT to spend" read as a second buy request, so
 * one watch became two and Fi answered "I'll start with the first one". Intent words alone can
 * never open a second item; only a segment carrying its own product identity can. A segment
 * with intent but no identity continues the current item, and a later identity-bearing segment
 * with no intent of its own ("Need these three: 116500LN, 126710BLRO, 5712G") inherits it.
 *
 * Folded segments keep the author's original text between them, so the item's query reads as
 * they wrote it rather than as a comma list.
 */
export function parseItemRequests(text: string): ItemRequest[] {
  // A comma inside a formatted number is data, not a separator: "$110,000" must stay whole.
  const splitter = /\n|,(?!\d)|;|\band\b/gi;
  const segments: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  for (const m of text.matchAll(splitter)) {
    segments.push({ text: text.slice(cursor, m.index).trim(), start: cursor, end: m.index! });
    cursor = m.index! + m[0].length;
  }
  segments.push({ text: text.slice(cursor).trim(), start: cursor, end: text.length });

  const items: (ItemRequest & { start: number })[] = [];
  const seen = new Set<string>();
  let inheritedAction: ItemRequest["action"] | null = null;
  const push = (action: ItemRequest["action"], rawQuery: string, start: number) => {
    const query = rawQuery.replace(/[\s,;.!?]+$/, "");
    const key = `${action}:${query.toLowerCase()}`;
    if (seen.has(key) || !query) return;
    seen.add(key);
    items.push({ action, query, start });
  };
  const fold = (end: number) => {
    const last = items[items.length - 1];
    last.query = stripLeadingIntent(text.slice(last.start, end).trim()).replace(/[\s,;.]+$/, "");
  };

  for (const seg of segments) {
    if (!seg.text) continue;
    const own = classify(seg.text);
    const identity = carriesProductIdentity(seg.text);
    if (own && identity) { inheritedAction = own.action; push(own.action, own.query, seg.start); }
    else if (own && !items.length) { inheritedAction = own.action; push(own.action, own.query, seg.start); } // "I want to buy a watch"
    else if (!own && identity && inheritedAction && items.length) push(inheritedAction, stripLeadingIntent(seg.text), seg.start);
    else if (items.length) fold(seg.end);
    // Chatter before any item ("hi there, …") is ignored, as it always was.
  }
  return items.map(({ action, query }) => ({ action, query }));
}

interface DecisionCommand {
  action: "approve" | "pass";
  // 1-based, or null when not specified — spec: "approve/pass without a number applies to the
  // latest unresolved match" (resolved by handleDecision, which has the pending set to search;
  // this parser has no state to resolve it against).
  index: number | null;
}

// `(?:\b|(?=\d))` instead of a plain `\b` — a real reported miss: "Photos2" (no space before
// the number) has NO word boundary between "s" and "2" (both are word characters), so a plain
// `\b` never matches it at all and the whole message silently fell through to general chat.
// The lookahead alternative accepts a digit run immediately after the word with no boundary
// needed, while still requiring an actual boundary (not just any following text) otherwise —
// "approve1"/"pass1"/"photos2" now all work the same as "approve 1"/"pass 1"/"photos 2".
function parseDecisionCommand(text: string): DecisionCommand | null {
  const m = text.trim().match(/^(approve|pass)(?:\b|(?=\d))\s*#?(\d+)?/i);
  if (!m) return null;
  return { action: m[1].toLowerCase() as "approve" | "pass", index: m[2] ? parseInt(m[2], 10) : null };
}

/** Matches "photos <n>", "photo <n>", and "request photos <n>" (spec's three accepted forms). */
function parsePhotoRequestCommand(text: string): number | null {
  const m = text.trim().match(/^(?:request\s+)?photos?(?:\b|(?=\d))\s*#?(\d+)?/i);
  if (!m) return null;
  return m[1] ? parseInt(m[1], 10) : 1;
}

// Help/menu intentionally exclude START: START has distinct reset/onboarding behavior below,
// while help must always return the complete deterministic menu without consuming onboarding.
const MENU_COMMAND = /^(?:help|menu)\b/i;
const CANCEL_COMMAND = /^cancel\b/i;

/** A message that is ONLY a greeting — nothing else in it to act on. "hi, I want a Daytona"
 *  deliberately does not match; that message has a real request in it. */
const BARE_GREETING = /^(?:hi|hello|hey|hiya|yo|sup|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|fi|bot))?\s*[!.,?]*$/i;

/**
 * Account-level intents: questions about the USER — their membership, their plan, their usage —
 * never an answer to whatever question Fi last asked about a draft.
 *
 * Matched on content words rather than as fixed sentences. The live failure this replaces:
 * "status" worked because it was an exact anchored command, but "membership status" and "what
 * plan am I on" matched nothing, fell through to the open WTB intake, and got answered with a
 * reprint of the draft. Enumerating more exact sentences would just move the boundary; asking
 * "does this name an account topic AND ask about it" generalizes instead.
 */
function parseAccountIntent(text: string): "membership" | "status" | null {
  const t = normalize(text).replace(/[?.!,]+$/g, "").trim();
  if (!t) return null;
  const topic = /\b(?:membership|member|subscription|billing|plan|tier|package)\b/.test(t);
  const asking = /\b(?:status|state|what|whats|which|current|currently|level|check|show|tell|have|has|do|does|am|is|are|my|on)\b/.test(t);
  if (topic && asking) return "membership";
  if (/^(?:status|account\s+status|my\s+status|what(?:'s|s| is)\s+my\s+status|where\s+do\s+i\s+stand)\b/.test(t)) return "status";
  if (/\b(?:how\s+many)\b.*\b(?:approvals?|matches)\b.*\b(?:left|remaining)\b/.test(t)) return "status";
  return null;
}
// Broadened past the exact word "listings" for the same reason — "listing summary", "my
// listing", "edit my listings", and "summary" are all natural ways to ask for the same thing.
const LISTINGS_COMMAND = /^(my\s+)?(listings?(\s+summary)?|summary)\b/i;
const MY_ACTIVE_LISTINGS_COMMAND = /^(?:what\s+are\s+my\s+listings?|show\s+(?:me\s+)?my\s+(?:listings?|fs|wtb)|my\s+listings|(?:i\s+(?:need|want|would\s+like)\s+to\s+)?(?:edit|manage)\s+my\s+listings?|what\s+am\s+i\s+(?:selling|buying)|my\s+active\s+tasks?|what\s+are\s+you\s+monitoring\s+for\s+me)\s*[?.!]*$/i;
const CURRENT_INVENTORY_COMMAND = /^(?:show(?:\s+me)?\s+(?:current\s+|watchfacts\s+|available\s+)?listings|show(?:\s+me)?\s+inventory|what(?:'s|\s+is)\s+available|current\s+listings)(?:\s+for\s+.+|\s+.+)?[?.!]*$/i;

/** "Show prices in EUR" / "Use HKD as my preferred currency" — automatic currency conversion
 *  (src/fx/) display preference. Returns the requested ISO code (uppercased, NOT yet validated
 *  against CURRENCY_CODES) or null when the text doesn't match either accepted form. */
function parseCurrencyPreferenceCommand(text: string): string | null {
  const t = text.trim();
  const shown = t.match(/^show\s+prices?\s+in\s+([a-z]{3})\b/i);
  if (shown) return shown[1].toUpperCase();
  const used = t.match(/^use\s+([a-z]{3})\s+as\s+(?:my\s+)?preferred\s+currency\b/i);
  if (used) return used[1].toUpperCase();
  return null;
}

/** Stores a contact's preferred display currency (requirement #11) — never affects the
 *  USD-budget comparison itself (see resolveComparablePrice in matching/engine.ts), only which
 *  currency the "Approximately: ..." estimate line is converted into. An unrecognized code is
 *  rejected rather than silently stored — never guess that a typo'd code is a real currency. */
function handleCurrencyPreferenceCommand(state: ConversationState, code: string, messages: string[]): void {
  if (!CURRENCY_CODES.includes(code)) {
    messages.push(`I don't recognize "${code}" as a currency. Supported: ${CURRENCY_CODES.join(", ")}.`);
    return;
  }
  state.preferredDisplayCurrency = code;
  messages.push(`Got it — I'll show prices in ${code} from now on.`);
}

type NotificationChannelIntent = { kind: "set"; channel: ChannelPlatform } | { kind: "status" };

/**
 * "Send my matches by SMS." / "Notify me on Telegram." / "Use WhatsApp for alerts." / "Where
 * are you sending my notifications?" — where Fi ALERTS a contact is a preference on the
 * canonical account (see postings/notificationPreferences.ts), deliberately independent of
 * whichever channel they happen to be chatting on right now: a dealer might manage listings on
 * Telegram but want matches pushed by SMS.
 */
function parseNotificationChannelCommand(text: string): NotificationChannelIntent | null {
  const t = text.trim().replace(/[?.!]+$/, "");
  if (!t) return null;

  if (
    /^where\s+(?:are\s+you|do\s+you)\s+send(?:ing)?\s+my\s+(?:notifications?|alerts?|matches?)$/i.test(t) ||
    /^what(?:'s|\s+is)\s+my\s+(?:preferred\s+)?(?:notification|alert)\s+channel$/i.test(t)
  ) {
    return { kind: "status" };
  }

  const channelWord = "(whatsapp|telegram|sms|text\\s*message|text)";
  const patterns = [
    new RegExp(`^send\\s+my\\s+(?:matches|notifications|alerts)\\s+(?:by|on|via|through)\\s+${channelWord}$`, "i"),
    new RegExp(`^notify\\s+me\\s+(?:by|on|via|through)\\s+${channelWord}$`, "i"),
    new RegExp(`^use\\s+${channelWord}\\s+for\\s+(?:my\\s+)?(?:matches|notifications|alerts)$`, "i"),
    new RegExp(`^(?:set\\s+)?(?:my\\s+)?(?:notification|alert)\\s+channel\\s+(?:to|=)\\s+${channelWord}$`, "i"),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const word = m[1].toLowerCase().replace(/\s+/g, " ");
    const channel: ChannelPlatform = word === "whatsapp" || word === "telegram" ? word : "sms";
    return { kind: "set", channel };
  }
  return null;
}

/** "link A1B2C3D4" — completes a Telegram identity link started by handleNotificationChannelCommand
 *  below. Checked as one of the very FIRST things in handleIncomingMessage, before anything that
 *  might call getOrCreateCanonicalUser for the identity sending it — linking must attach that
 *  identity to the EXISTING canonical user the code names, never create it a fresh one first. */
const LINK_CODE_COMMAND = /^link\s+([0-9a-f]{8})$/i;

async function handleLinkCodeCommand(phone: string, code: string, messages: string[]): Promise<void> {
  const platform = platformForIdentity(phone);
  const consumed = await consumePendingIdentityLink(code, platform);
  if (!consumed.ok) {
    messages.push(
      consumed.reason === "expired"
        ? 'That code has expired — say something like "notify me on Telegram" again to get a new one.'
        : consumed.reason === "wrong_platform"
        ? "That code isn't for this channel."
        : "I don't recognize that code — it may already have been used."
    );
    return;
  }
  const linked = await linkIdentity(consumed.canonicalUserId, platform, phone);
  if (!linked.ok) {
    messages.push(
      linked.reason === "already_linked_here"
        ? "This account is already linked."
        : "This account is already linked to a different Fi account, so I can't connect it here."
    );
    return;
  }
  await setPreferredChannel(consumed.canonicalUserId, platform);
  messages.push(`Linked! I'll send your matches and alerts on ${channelLabel(platform)} from now on.`);
}

/** Phone-based channels (SMS, WhatsApp) link directly by number; Telegram needs the code flow
 *  above instead, since there's no phone number the user can type in for a chat id. */
function phoneIdentityForChannel(channel: "whatsapp" | "sms", digits: string): string {
  return channel === "sms" ? smsIdentity(`+${digits}`) : digits;
}

async function handleNotificationChannelCommand(state: ConversationState, intent: NotificationChannelIntent, messages: string[]): Promise<void> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(state.phone), state.phone);

  if (intent.kind === "status") {
    const pref = await getNotificationPreference(canonicalUserId);
    const linked = await getLinkedIdentities(canonicalUserId);
    if (!pref.preferredChannel) {
      messages.push(
        linked.length > 0
          ? `You haven't set a preferred notification channel — right now I'd send your matches and alerts by ${channelLabel(linked[0].platform)}. Say "notify me on WhatsApp/Telegram/SMS" to set one.`
          : 'No channel linked yet. Say "notify me on WhatsApp/Telegram/SMS" to set one up.'
      );
      return;
    }
    const isLinked = linked.some((l) => l.platform === pref.preferredChannel);
    messages.push(
      [
        `Preferred notification channel: ${channelLabel(pref.preferredChannel)}${isLinked ? "" : " (not linked yet)"}`,
        `Fallback delivery: ${pref.fallbackEnabled ? "on — I'll try another linked channel if this one fails" : "off"}`,
        linked.length > 0 ? `Linked: ${linked.map((l) => channelLabel(l.platform)).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
    return;
  }

  const linked = await getLinkedIdentities(canonicalUserId);
  await setPreferredChannel(canonicalUserId, intent.channel);
  if (linked.some((l) => l.platform === intent.channel)) {
    messages.push(`Got it — I'll send your matches and alerts on ${channelLabel(intent.channel)} from now on.`);
    return;
  }

  if (intent.channel === "telegram") {
    const code = await createPendingIdentityLink(canonicalUserId, "telegram");
    messages.push(`Got it — I'll use Telegram once it's linked. Message me "link ${code}" from Telegram to connect it (this code expires in 15 minutes).`);
    return;
  }
  state.pendingChannelLink = intent.channel;
  messages.push(`Got it — I'll use ${channelLabel(intent.channel)} once it's linked. What's the best phone number to reach you at on ${channelLabel(intent.channel)}?`);
}
// A bare greeting (spec: "'hi' should return the Fi menu, not force approve/pass") is NOT its
// own deterministic command here — a brand-new contact's first "hi" must still get the normal
// intro message (see state.stage === "new" below), and an existing contact's "hi" with matches
// pending must still get the ordinary general-chat reply, not a menu dump. The one concrete risk
// a greeting actually posed was being swallowed by AI decision-interpretation (interpretDecision,
// below) — this is checked there directly, so a greeting always falls through to the normal
// intro/general-chat path instead.
const GREETING = /^(hi|hello|hey|hiya|yo|good\s+(morning|afternoon|evening))\b/i;

const FI_MENU = [
  "Hi, I'm Fi — here's what I can do. Tell me naturally what you're looking to buy or sell, or choose an option below:",
  '"buy: <item>" or "sell: <item>" — search for a match (plain English works too, e.g. "looking for a black Daytona under 25k")',
  '"approve <number>" — connect with a match',
  '"photos <number>" — privately ask the seller for photos',
  '"pass <number>" — skip a match',
  '"cancel" — clear your current matches',
  '"status" — check your account status',
  '"listings" — see your approved matches, pending matches, or your own WTB/FS listings',
  '"Show prices in EUR" (or USD/GBP/HKD/etc.) — set your preferred display currency',
  '"help" — show this menu',
].join("\n");

const LISTINGS_MENU = [
  "What would you like to see?",
  "1. Matches I've approved",
  "2. Matches still pending my decision",
  "3. My current WTB/FS listings",
  "",
  "Reply with a number.",
].join("\n");

/** Option 1 — durable across searches (unlike v3's own pendingMatches, which a new search
 *  replaces): reads live from Postgres (approvalUsage.ts), the same store both the v3 and v4
 *  approve paths write to. A still-pending mutual confirmation shows as "waiting on the other
 *  side to confirm" rather than a contact — never surfaced before it's actually safe to. */
async function formatApprovedListingsSummary(phone: string): Promise<string> {
  const summary = await getApprovedMatchesSummary(phone);
  if (summary.length === 0) return "You haven't approved any matches yet.";
  const lines = summary.map((s, i) => {
    const contact = s.counterpartName && s.counterpartPhone ? `${s.counterpartName}: ${s.counterpartPhone}` : "waiting on the other side to confirm";
    return `${i + 1}. ${s.listingDescription} — ${contact}`;
  });
  return "Your approved matches:\n\n" + lines.join("\n");
}

/** Option 2 — the CURRENT search's own numbered list, filtered to what's still undecided.
 *  Numbering matches the original Match Cards (not re-indexed), so "approve <number>" still
 *  works against it directly. */
function formatPendingListingsSummary(state: ConversationState): string {
  const pending = state.pendingMatches;
  const lines = pending
    ? pending.matches
        .map((m, i) => (pending.decisions[i] === "pending" ? `${i + 1}. ${m.item} — $${m.price}` : null))
        .filter((l): l is string => l !== null)
    : [];
  if (lines.length === 0) return "Nothing is currently awaiting your approve/pass.";
  return `Matches still awaiting your decision:\n\n${lines.join("\n")}\n\nReply "approve <number>" or "pass <number>".`;
}

/** Option 3 — a canonical user's own live monitors (postingsStore.ts's getActivePostingsForUser).
 *  A v3 on-demand "buy:"/"sell:" search never shows up here — only the sell-intake flow and
 *  group-chat WTB/FS messages persist an actual monitored posting; a plain search is a one-off
 *  lookup against live inventory, not something Fi is actively watching on your behalf. */
async function formatMyListingsSummary(phone: string): Promise<string> {
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const postings = await getActivePostingsForUser(canonicalUserId);
  if (postings.length === 0) return "You don’t have any active buy or sell tasks right now.\nTell me what you want to buy or sell and I’ll start working on it.";
  const lines = postings.map((p, i) => `${i + 1}. ${formatStructuredPosting(p)}`);
  return `You currently have ${postings.length} active task${postings.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}\n\nYou can say:\n"change listing 2 price to 35,000"\n"expand listing 1 to worldwide"\n"pause listing 1"\n"close listing 2"`;
}

function formatAmount(value: string, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return currency === "USD" ? `$${value}` : `${currency} ${value}`;
  const formatted = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency === "USD" ? `$${formatted}` : `${currency} ${formatted}`;
}

/** Uses only persisted structured columns; the original message is deliberately not re-parsed. */
function displayBrand(value?: string | null): string {
  const brandNames: Record<string, string> = {
    rolex: "Rolex", omega: "Omega", cartier: "Cartier", tudor: "Tudor", panerai: "Panerai", iwc: "IWC",
    patek: "Patek", "patek philippe": "Patek Philippe", "audemars piguet": "Audemars Piguet",
    "richard mille": "Richard Mille", "vacheron constantin": "Vacheron Constantin", hermes: "Hermes", "hermès": "Hermès",
  };
  return value ? (brandNames[value.trim().toLowerCase()] ?? value.trim()) : "";
}

function formatStructuredPosting(p: import("../postings/postingsStore").PostingRow): string {
  const brand = displayBrand(p.brand);
  const rawModel = p.model?.trim() ?? "";
  const cleanedModel = stripLeadingIntent(rawModel).replace(/\bonly\b\s*$/i, "").trim();
  const model = cleanedModel && !/^(?:only|a|an|the|i want(?: to buy)?(?: a)?|(?:i(?:'m| am) )?looking for(?: a)?|i need(?: a)?|need a|want a|buy a|wtb(?: a)?)$/i.test(rawModel) ? cleanedModel : "";
  const identity = [brand, model, p.reference].filter(Boolean).join(" ") || "Legacy listing — identity incomplete";
  return [
    `${p.type} —${identity ? ` ${identity}` : ""}`,
    p.dial ? `${p.dial} dial` : "",
    p.condition,
    p.price ? `${p.type === "FS" ? "Asking" : "Budget"}: ${formatAmount(p.price, p.currency || "USD")}` : "",
    p.location,
  ].filter(Boolean).join("\n");
}

function listingIdentityText(listing: InventoryListing): string {
  return [listing.brand, listing.item, listing.ref, listing.description].filter(Boolean).join(" ").toLowerCase();
}

function formatCurrentInventory(listings: InventoryListing[], requestLabel: string): string {
  if (listings.length === 0) {
    return "I don’t see any current WatchFacts listings that fit this request right now. I’ll keep monitoring.";
  }
  const cards = listings.map((listing, index) => {
    const itemAlreadyHasIdentity = listing.item && [listing.brand, listing.ref].filter(Boolean).every((part) => listing.item.toLowerCase().includes(part.toLowerCase()));
    const title = itemAlreadyHasIdentity ? listing.item : [listing.brand, listing.item, listing.ref].filter(Boolean).join(" ");
    return [
      `${index + 1}. ${title}`,
      listing.condition || "",
      listing.price && !/^ask$/i.test(listing.price) ? formatAmount(listing.price, listing.nativeCurrency || listing.priceCurrency || "USD") : "",
      listing.location || "",
      listing.detailUrl ? `Source: ${listing.detailUrl}` : "",
      listing.imageUrl ? `Photo: ${listing.imageUrl}` : "",
    ].filter(Boolean).join("\n   ");
  });
  return `Here ${listings.length === 1 ? "is" : "are"} ${listings.length} current WatchFacts listing${listings.length === 1 ? "" : "s"} for ${requestLabel}:\n\n${cards.join("\n\n")}`;
}

/** Reads only the normalized, active WatchFacts inventory. The command is resolved before AI
 * chat, and context comes from persisted posting columns rather than re-parsing old messages. */
async function handleCurrentInventoryCommand(state: ConversationState, text: string): Promise<string> {
  const explicitReference = extractReference(text);
  let active: import("../postings/postingsStore").PostingRow[] = [];
  let context:
    | {
        type: "FS" | "WTB";
        brand?: string | null;
        model?: string | null;
        reference?: string | null;
        price?: number | string | null; // PendingSellIntake/PostingRow name their stated figure "price"
        budget?: number | string | null; // PendingBuyIntake names the same concept "budget"
        currency?: string | null;
        location?: string | null;
        dial?: string | null; // PostingRow
        dialColor?: string | null; // PendingBuyIntake/PendingSellIntake
      }
    | undefined;

  if (explicitReference) {
    context = { type: state.pendingSellIntake ? "FS" : "WTB", reference: explicitReference };
  } else if (state.pendingBuyIntake) {
    context = { type: "WTB", ...state.pendingBuyIntake };
  } else if (state.pendingSellIntake) {
    context = { type: "FS", ...state.pendingSellIntake };
  } else {
    const userId = await getOrCreateCanonicalUser(platformForIdentity(state.phone), state.phone);
    active = await getActivePostingsForUser(userId);
    if (active.length === 1) context = active[0];
    else if (active.length > 1) return "Which listing or watch do you mean? Please include the reference number.";
  }

  if (!context) return "Which watch do you mean? Please include the brand, model, or reference number.";
  const desiredType = context.type === "WTB" ? "FS" : "WTB";
  const requestedReference = explicitReference || context.reference || undefined;
  const terms = (explicitReference ? [] : [context.brand, context.model]).filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
  const all = await getActiveListings(desiredType);
  const seen = new Set<string>();
  const candidates = all.filter((listing) => {
    if (listing.source !== "WF" || (!listing.ref && !listing.brand && !listing.item)) return false;
    if (listing.contactPhone && listing.contactPhone === state.phone) return false;
    if (requestedReference && !listing.ref) return false;
    if (requestedReference && !referencesMatch(requestedReference, listing.ref)) return false;
    if (terms.length && !terms.every((term) => listingIdentityText(listing).includes(term))) return false;
    const key = [listing.type, listing.ref.toUpperCase(), listing.price, listing.contactPhone, listing.detailUrl || listing.description].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // A stated price is a real monetary constraint, same as findMatches/findMatchesHybrid — this
  // step is showing what's ALREADY available for the request the buyer/seller just confirmed,
  // so ignoring the budget/ask they just gave (a real reported bug: a stated $25,000 budget
  // still surfaced $29,500-$31,000 listings) is worse than showing fewer results. Currency-aware
  // so a stated USD figure isn't compared against a raw EUR/GBP one.
  const statedAmount = context.budget ?? context.price;
  const statedNumber = statedAmount !== null && statedAmount !== undefined ? Number(statedAmount) : undefined;
  let priceFiltered = candidates;
  if (statedNumber !== undefined && Number.isFinite(statedNumber)) {
    const statedUsd = await convertMoneyToUsd({ amount: statedNumber, currency: (context.currency as CurrencyCode) || "USD" });
    const withPrice = await Promise.all(
      candidates.map(async (listing) => {
        if (!listing.price || /^ask$/i.test(listing.price)) return null; // unverifiable against a stated constraint
        const listingUsd = await convertMoneyToUsd({
          amount: Number(listing.price),
          currency: (listing.nativeCurrency || listing.priceCurrency || "USD") as CurrencyCode,
        });
        if (statedUsd === null || listingUsd === null) return null;
        // Buyer context (WTB) browsing FS: only show asks at or under the stated budget.
        // Seller context (FS) browsing WTB: only show requests whose budget meets the ask.
        const withinConstraint = context!.type === "WTB" ? listingUsd <= statedUsd : listingUsd >= statedUsd;
        return withinConstraint ? listing : null;
      })
    );
    priceFiltered = withPrice.filter((l): l is InventoryListing => l !== null);
  }

  // Dial/location are informational only, not exclusionary — same reasoning as
  // matching/engine.ts's softPreferenceScore: WatchFacts data is often sparse (no dial_color) or
  // only continent-level (region, not city), so treating a mismatch there as disqualifying would
  // drop otherwise-relevant listings over nothing but missing/coarse data.
  const statedDial = (context.dialColor ?? context.dial ?? "").trim().toLowerCase();
  const statedLocation = (context.location ?? "").trim().toLowerCase();
  const relevant = priceFiltered
    .map((listing) => {
      let score = 0;
      if (statedDial && `${listing.description} ${listing.item}`.toLowerCase().includes(statedDial)) score += 1;
      const listingLocation = (listing.location ?? "").trim().toLowerCase();
      if (statedLocation && listingLocation && (listingLocation.includes(statedLocation) || statedLocation.includes(listingLocation))) score += 1;
      return { listing, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => r.listing)
    .slice(0, 5);
  const label = [context.brand, context.model, explicitReference || context.reference].filter(Boolean).join(" ") || "this request";
  return formatCurrentInventory(relevant, label);
}

function formatActiveAcknowledgment(p: import("../postings/postingsStore").PostingRow, matchesFound: number): string {
  const heading = p.type === "FS" ? "Your FS listing is active:" : "Your WTB request is active:";
  const details = formatStructuredPosting(p).replace(/^(?:FS|WTB) —\s*/, "");
  const outcome = matchesFound
    ? `I found ${matchesFound} potential ${p.type === "FS" ? "buyer" : "listing"}${matchesFound === 1 ? "" : "s"}.`
    : `I’ll keep monitoring for a qualifying ${p.type === "FS" ? "buyer" : "seller"}.`;
  return `${heading}\n\n${details}\n\n${outcome}\n\n${whatHappensNext(p.type)}`;
}

/** Closes the activation card with the three things a user can actually do from here. Kept in
 *  the same message (not a follow-up) so both channels show one card and nobody gets nagged. */
function whatHappensNext(type: "FS" | "WTB"): string {
  return [
    "What happens next:",
    `• I’ll message you here the moment a matching ${type === "FS" ? "buyer" : "listing"} appears, with an approve / pass choice.`,
    `• Reply "listings" any time to review this ${type === "FS" ? "listing" : "request"}, or "cancel" to stop monitoring.`,
    "• Reply \"help\" for everything else I can do.",
  ].join("\n");
}

/** A one-time nudge right after the contact's first successful listing — the moment they've
 *  just seen Fi actually work is also the moment "where should I alert you" is most concretely
 *  useful, rather than a cold-onboarding question with nothing yet to attach it to. Silently
 *  skipped once a preference already exists (set via handleNotificationChannelCommand, or a
 *  future one), and never repeated regardless of that outcome. */
async function maybeNudgeChannelPreference(state: ConversationState, messages: string[]): Promise<void> {
  if (state.channelPreferenceNudgeShown) return;
  state.channelPreferenceNudgeShown = true;
  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(state.phone), state.phone);
  const pref = await getNotificationPreference(canonicalUserId);
  if (pref.preferredChannel) return;
  messages.push(
    'One-time question: how would you like me to notify you when I find a buyer, seller, or market opportunity? Reply "notify me on WhatsApp", "Telegram", or "SMS" — or ignore this and I\'ll keep using wherever you\'re chatting with me now.'
  );
}

/** "status" — a quick, honest snapshot of trial/plan usage and anything still awaiting a
 *  decision. Reads live from the same canonical Postgres counter both the on-demand (v3) and
 *  automatic-matching (v4) approve paths share (see postings/approvalUsage.ts) — never a
 *  locally-cached count that could drift from what actually gated the last approval. */
async function handleStatusCommand(state: ConversationState, messages: string[]): Promise<void> {
  const pendingCount = state.pendingMatches?.decisions.filter((d) => d === "pending").length ?? 0;
  const usage = await getApprovalUsage(state.phone);
  // The complimentary allowance is spent before a plan's own allowance regardless of whether a
  // membership exists, so the approval line below reads identically for a paid and an unpaid
  // account until three approvals have been used. Naming the plan separately is what makes the
  // two distinguishable: a live "status" reading 0/3 was taken as evidence that a completed
  // payment had not activated, when status simply never mentioned membership at all.
  const membershipLine = usage.entitlement.plan
    ? `Membership: ${MEMBERSHIP_PLANS[usage.entitlement.plan].label}${usage.entitlement.canceledAt ? " — canceled" : " — active"}`
    : null;
  let approvalLine: string;
  if (usage.isComplimentary) {
    approvalLine =
      `Approved matches: ${usage.totalApproved}/${config.trial.maxApprovedMatches} (complimentary trial` +
      (usage.entitlement.plan ? `, used before your plan's allowance` : "") +
      ")";
  } else if (usage.weeklyLimit === null) {
    approvalLine = `Approved matches: unlimited (your plan has no weekly cap)`;
  } else if (usage.weeklyLimit === 0) {
    approvalLine = `Approved matches: locked — no active Fi membership. Message "join" to get started.`;
  } else {
    const planLabel = MEMBERSHIP_PLANS[usage.entitlement.plan!].label;
    approvalLine = `Approved matches this week: ${usage.weeklyUsed}/${usage.weeklyLimit} (${planLabel} plan)`;
  }
  const pendingLine =
    pendingCount > 0
      ? `Pending decisions: ${pendingCount} match${pendingCount === 1 ? "" : "es"} awaiting approve/pass`
      : "No matches currently awaiting a decision.";
  messages.push([membershipLine, approvalLine, pendingLine].filter(Boolean).join("\n"));
}

/** "cancel" — clears the current pending match set (and any in-progress preference interview)
 *  without unsubscribing. A deliberate, explicit user action, distinct from a new search
 *  superseding an old one — see the "never delete a pending match merely because another search
 *  starts" rule this does NOT apply to. */
/** "12 minutes ago" / "3 hours ago" / "2 days ago" — plain enough for a chat message. */
function describeAge(isoTimestamp: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Answers "membership status" / "what plan am I on" from the entitlement record itself, rather
 * than from the approval counter alone — a user asking about their membership wants to know
 * whether a payment actually landed, which the trial counter cannot tell them.
 */
async function handleMembershipCommand(state: ConversationState, messages: string[]): Promise<void> {
  const usage = await getApprovalUsage(state.phone);
  const { plan, paymentStatus, canceledAt } = usage.entitlement;
  const lines: string[] = [];
  if (plan) {
    const planDef = MEMBERSHIP_PLANS[plan];
    lines.push(`Membership: ${planDef.label} (${planDef.priceLabel})${canceledAt ? " — canceled" : " — active"}`);
    lines.push(
      usage.weeklyLimit === null
        ? "Approvals: unlimited on this plan"
        : `Approvals this week: ${usage.weeklyUsed}/${usage.weeklyLimit}`
    );
  } else {
    lines.push("Membership: none active yet.");
    lines.push(`Complimentary approvals used: ${usage.totalApproved}/${config.trial.maxApprovedMatches}`);
    // A membership activates only when Authorize.net's webhook confirms the saved card, so a
    // checkout that was started and never confirmed is invisible on the entitlement record —
    // the account reads exactly like one that never tried to join. Saying which of the two it
    // is turns "I paid and nothing happened" into something answerable.
    const attempt = await findLatestCheckoutAttempt(state.phone);
    if (attempt?.status === "pending") {
      lines.push(`A ${MEMBERSHIP_PLANS[attempt.plan].label} checkout was started ${describeAge(attempt.createdAt)} and hasn't been confirmed yet.`);
      lines.push(`If you already paid, tell me and I'll have it checked — otherwise finish here: ${config.publicBaseUrl}/pay/${attempt.id}`);
    } else if (attempt?.status === "failed") {
      lines.push(`Your last ${MEMBERSHIP_PLANS[attempt.plan].label} payment attempt was declined.`);
    }
    lines.push('Reply "join" to start a membership, or "upgrade" to compare the plans.');
  }
  // Surfaced whenever it exists so a checkout that was started but never completed is visible
  // here instead of looking like an unexplained locked account.
  if (paymentStatus) lines.push(`Last payment status: ${paymentStatus}`);
  messages.push(lines.join("\n"));
}

function handleCancelCommand(state: ConversationState, messages: string[]): void {
  const hadSomethingToCancel = Boolean(
    state.pendingMatches || state.pendingPreferenceCollection || state.pendingNaturalFollowUp || state.pendingSellIntake || state.pendingBuyIntake || state.pendingChannelLink
  );
  state.pendingMatches = undefined;
  state.pendingPreferenceCollection = undefined;
  state.pendingNaturalFollowUp = undefined;
  state.pendingSellIntake = undefined;
  state.pendingBuyIntake = undefined;
  state.pendingReplacementRequest = undefined;
  state.pendingEscrowOffer = false;
  state.pendingListingsMenu = false;
  state.pendingChannelLink = undefined;
  messages.push(
    hadSomethingToCancel
      ? "Okay, I've cleared your current matches. Send a new buy/sell request anytime."
      : "There's nothing pending to cancel right now."
  );
}

export interface FlowResult {
  state: ConversationState;
  messages: string[];
}

const MARKET_COMMAND = /^(?:market pulse|market briefing|market update|market for my listing|market on my watch|price pulse|how is the market|show market data)\s*[?.!]*$/i;
const MARKET_BRIEFING_COMMAND = /^(?:market briefing|market update)\s*[?.!]*$/i;
/** The whole monitored network, independent of what this account happens to be listing. */
const MARKET_OVERVIEW_COMMAND = /^(?:market overview|overall market|whole market|network market|market snapshot|how(?:'s| is) the whole market)\s*[?.!]*$/i;
const MARKET_REFERENCE_COMMAND = /^(?:market\s+pulse|price\s+pulse|market\s+price|market\s+data|market\s+check|market|pulse)\s+(?:on\s+|for\s+)?(.+)$/i;

/**
 * "market pulse 116500LN", "market pulse Rolex 116500LN", "market 116500LN", "price pulse
 * 116500LN" — a reference spelled out in the command is a complete, self-contained instruction.
 *
 * Reported live failure: MARKET_COMMAND is fully anchored and accepts no argument, so "market
 * pulse 116500LN" matched nothing, fell through to pending-intake handling, and Fi reprinted
 * the open WTB draft. An explicit reference must resolve deterministically against the database
 * and must never be interpreted against whatever listing or draft happens to be open, so this
 * is parsed before every context-dependent branch.
 *
 * The argument has to BE a reference and nothing else, which is what keeps the existing
 * context-scoped phrasings ("market for my listing", "market briefing") out of this branch.
 */
function parseMarketReferenceCommand(text: string): { reference: string; brand?: string } | null {
  const m = text.trim().replace(/\s*[?.!]+$/, "").match(MARKET_REFERENCE_COMMAND);
  if (!m) return null;
  const { brand, rest } = splitLeadingBrand(m[1]);
  const candidate = rest.replace(/^(?:the\s+)?(?:ref(?:erence)?\.?\s*)?/i, "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9./-]*$/.test(candidate)) return null;
  const reference = extractReference(candidate);
  // extractReference finds a reference ANYWHERE in its input; require that it consumed the whole
  // argument, so "market pulse daytona" isn't silently treated as a reference lookup.
  if (!reference || normalizeReference(reference) !== normalizeReference(candidate)) return null;
  return { reference, ...(brand ? { brand } : {}) };
}

interface ListingEditCommand { action: "edit" | "price" | "location" | "dial" | "reference" | "pause" | "resume" | "close"; index: number | null; value?: string | number; typeHint?: "FS" | "WTB"; indices?: number[]; all?: boolean }

/** "listing 1", "listing #1", "listing  2" — anywhere in the sentence, not only after the verb. */
const LISTING_INDEX_PATTERN = /\blisting\s*#?\s*(\d+)\b/i;

/** Verbs that mean "manage a listing I already have", never "here is something new". */
const LISTING_MANAGEMENT_VERB = /^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(edit|change|update|set|make|lower|raise|reduce|increase|adjust|modify|revise|expand)\b\s*/i;

/** The editable fields, matched at the START of what's left after the listing number and the
 *  management verb have been removed. */
const LISTING_EDIT_FIELDS: ReadonlyArray<{ action: "price" | "location" | "dial" | "reference"; pattern: RegExp }> = [
  { action: "price", pattern: /^(?:asking\s+)?(?:price|budget|ask|max(?:imum)?)\b/i },
  { action: "location", pattern: /^(?:location|region|country|market|area)\b/i },
  { action: "dial", pattern: /^dial(?:\s+colou?r)?\b/i },
  // A mistyped reference is the one identity field worth correcting in place — the rest of a
  // listing's identity comes from the original message and is never re-derived from an edit.
  { action: "reference", pattern: /^(?:reference|ref)\b/i },
];

/** Optional connector between a field and its new value — "price to 2500", "price = 2500",
 *  "price is 2500", or nothing at all ("price 2500"). */
const LISTING_FIELD_CONNECTOR = /^(?:to|=|:|is|as|at|of|be)\b\s*/i;

/** A plain listing amount: "2500", "$2,500", "2.5k". Null when the text isn't only an amount. */
function parseListingAmount(raw: string): number | null {
  const m = raw.trim().match(/^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(k)?$/i);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Listing-management commands, parsed by grammar rather than by a list of exact sentences.
 *
 * The reported live failure: with a WTB draft open, "edit listing 1 price 2500" matched none of
 * the old hand-written sentence patterns, fell through to pending-intake handling, and changed
 * the DRAFT'S budget instead of listing #1. The number, the verb and the field name can each
 * appear in more than one order in real messages ("change listing 1 price to 2500" and "change
 * price listing 1 to 2500" are the same instruction), so the listing number is located and
 * removed FIRST and the remainder is parsed as a plain "<field> <value>" phrase — which makes
 * every ordering, and the bare "listing 1 price 2500" form, fall out of one rule.
 *
 * Index-less forms stay deliberately narrow (they still require "my"): during an interview,
 * "change the price to 2500" is an answer about the draft Fi is actively collecting, and must
 * keep going to the intake handler rather than being captured here.
 */
function parseListingEditCommand(text: string): ListingEditCommand | null {
  const t = text.trim().replace(/\s*[?.!]+$/, "");
  if (!t) return null;

  // "close all listings"/"pause all my listings" — every manageable listing at once, with no
  // number said at all. Checked before the numbered form below since it shares the same verbs
  // but never a digit.
  const lifecycleAll = t.match(/^(?:please\s+)?(pause|pausing|hold|resume|reactivate|restart|unpause|close|closing|delete|deleting|remove|cancel|stop|end)\s+(?:my\s+)?all\s+(?:my\s+)?listings?$/i);
  if (lifecycleAll) {
    const verb = lifecycleAll[1].toLowerCase();
    const action: ListingEditCommand["action"] = /^(pause|pausing|hold|stop)$/.test(verb) ? "pause"
      : /^(resume|reactivate|restart|unpause)$/.test(verb) ? "resume"
      : "close";
    return { action, index: null, all: true };
  }

  // A listing number may be a list ("close listing 1 and 2", "close listings 1, 2 & 3") rather
  // than one bare digit — the live-reported failure was that "close listing 1 and 2" matched
  // nothing here (the old pattern required exactly one trailing number), fell through to the
  // open WTB draft's answer handler, and reported "I kept your request draft open" instead of
  // closing anything. The word "listing(s)" itself is also optional — a follow-up live retest
  // showed "close 1 and 2" (verb directly on the numbers, no "listing" said at all) failing the
  // same way, and there's nothing else in this bot a bare "<lifecycle verb> <number(s)>" could
  // mean.
  const lifecycle = t.match(/^(?:please\s+)?(pause|pausing|hold|resume|reactivate|restart|unpause|close|closing|delete|deleting|remove|cancel|stop|end)\s+(?:my\s+)?(?:listings?\s*)?#?\s*(\d+(?:\s*(?:,|&|and)\s*#?\s*\d+)*)$/i);
  if (lifecycle) {
    const verb = lifecycle[1].toLowerCase();
    const action: ListingEditCommand["action"] = /^(pause|pausing|hold|stop)$/.test(verb) ? "pause"
      : /^(resume|reactivate|restart|unpause)$/.test(verb) ? "resume"
      : "close";
    const indices = lifecycle[2].split(/[^\d]+/).filter(Boolean).map(Number);
    return indices.length > 1 ? { action, index: null, indices } : { action, index: indices[0] };
  }

  const indexMatch = t.match(LISTING_INDEX_PATTERN);
  if (!indexMatch) {
    let m = t.match(/^(?:change|lower|raise|update|set)\s+my\s+(asking\s+)?(?:price|budget)\s+to\s+(\$?[\d,]+)$/i);
    if (m) {
      const value = parseListingAmount(m[2]);
      if (value !== null) return { action: "price", index: null, value, typeHint: m[1] ? "FS" : undefined };
    }
    m = t.match(/^change\s+(?:my\s+)?dial\s+to\s+(.+)$/i);
    if (m) return { action: "dial", index: null, value: m[1].trim() };
    return null;
  }

  const index = Number(indexMatch[1]);
  let body = t.replace(indexMatch[0], " ").replace(/\s+/g, " ").trim();
  const verb = body.match(LISTING_MANAGEMENT_VERB);
  if (verb) body = body.slice(verb[0].length).trim();
  body = body.replace(/^(?:my|the)\s+/i, "").trim();

  // "edit listing 1" on its own — a management verb with a number but no field yet.
  if (!body) return verb ? { action: "edit", index } : null;

  for (const field of LISTING_EDIT_FIELDS) {
    const named = body.match(field.pattern);
    if (!named) continue;
    const value = body.slice(named[0].length).trim().replace(LISTING_FIELD_CONNECTOR, "").trim();
    // Named the field but not the new value ("edit listing 1 price") — ask, don't guess.
    if (!value) return { action: "edit", index };
    if (field.action === "reference") {
      const reference = extractReference(value);
      // "edit listing 1 reference 28500" is a price typed into the wrong field, not a reference.
      if (!reference || looksLikePriceAnswer(value)) return null;
      return { action: "reference", index, value: reference };
    }
    if (field.action !== "price") return { action: field.action, index, value };
    const amount = parseListingAmount(value);
    return amount === null ? null : { action: "price", index, value: amount };
  }

  // "expand listing 1 to worldwide" — a bare "to <value>" after a management verb means the
  // listing's location; the field name is implied by the verb.
  const implied = verb && body.match(/^to\s+(.+)$/i);
  if (implied) return { action: "location", index, value: implied[1].trim() };
  return null;
}

async function userListings(phone: string): Promise<PostingRow[]> {
  const id = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  return getManageablePostingsForUser(id);
}

function chooseListingMessage(rows: PostingRow[], purpose: string): string {
  return `Which listing would you like ${purpose} for?\n\n${rows.map((p, i) => `${i + 1}. ${p.type} — ${[p.brand,p.model,p.reference].filter(Boolean).join(" ") || "Legacy listing"}`).join("\n")}\n\nReply with the listing number.`;
}

async function handleListingEdit(phone: string, command: ListingEditCommand): Promise<string> {
  let rows = await userListings(phone);
  if (command.typeHint) rows = rows.filter((p) => p.type === command.typeHint);
  if (command.all && rows.length === 0) return "You have no listings to manage right now.";
  // "close all listings" acts on every row in this same snapshot — reuses the indices path below
  // rather than a separate loop, since "every index" and "these specific indices" are the same
  // operation once the row count is known.
  const indices = command.all ? rows.map((_, i) => i + 1) : command.indices;
  // Every index in a bulk command ("close listing 1 and 2") resolves against this ONE snapshot
  // of rows, taken before any of them are actioned — closing #1 first would otherwise drop it
  // out of the manageable set and shift #2 into #1's place before it's even looked up.
  if (indices) {
    const results = await Promise.all(
      indices.map(async (idx) => {
        const posting = rows[idx - 1];
        if (!posting) return `I couldn't find listing ${idx}. Say "my listings" to see the current numbers.`;
        const updated = await setPostingManagementStatus(posting.id, command.action as "pause" | "resume" | "close");
        if (!updated) return `Listing ${idx} is not currently eligible to ${command.action}.`;
        return `Listing ${idx} ${command.action === "pause" ? "paused" : command.action === "resume" ? "resumed" : "closed"}:\n\n${formatStructuredPosting(updated)}`;
      })
    );
    return results.join("\n\n");
  }
  if (command.index === null && rows.length !== 1) return chooseListingMessage(rows, "to manage");
  const posting = command.index === null ? rows[0] : rows[command.index - 1];
  if (!posting) return `I couldn't find listing ${command.index}. Say "my listings" to see the current numbers.`;
  if (command.action === "edit") return `What would you like to change on listing ${command.index ?? 1}? You can change its price/budget, location, dial, or reference.`;
  let updated: PostingRow | null;
  if (["pause","resume","close"].includes(command.action)) {
    updated = await setPostingManagementStatus(posting.id, command.action as "pause" | "resume" | "close");
    if (!updated) return `Listing ${command.index ?? 1} is not currently eligible to ${command.action}.`;
    return `Listing ${command.index ?? 1} ${command.action === "pause" ? "paused" : command.action === "resume" ? "resumed" : "closed"}:\n\n${formatStructuredPosting(updated)}`;
  }
  updated = await updatePostingField(posting.id, command.action as "price" | "location" | "dial" | "reference", command.value!, posting.canonical_user_id ?? undefined);
  if (!updated) return "That listing is no longer active.";
  await runImmediateMatch(updated);
  return `Updated:\n\n${formatStructuredPosting(updated)}\n\nI'll use the updated terms for matching going forward.`;
}

async function formatMarketBriefing(phone: string): Promise<string> {
  const rows = (await userListings(phone)).filter((p) => p.status === "active");
  // With no listings of their own there is nothing to brief per-listing, and "you have none" is
  // a dead end. The network-wide snapshot is the useful answer to the same question.
  if (!rows.length) {
    return `You don’t have any active listings to brief yet — here’s the market Fi is watching.\n\n${formatNetworkMarketSnapshot(await getNetworkMarketSnapshot())}`;
  }
  const cards = await Promise.all(rows.map(async (p, i) => {
    if (!p.reference && !p.brand && !p.model) return `${i + 1}. ${formatStructuredPosting(p)}\n\nReference needed for exact pricing.`;
    const pulse = await getScopedMarketPulse({ brand: p.brand, model: p.model, reference: p.reference });
    // Show the same canonical reference the aggregation grouped on, so two listings that share
    // a watch can't be displayed as two differently-named rows with identical numbers.
    const shownReference = p.reference ? canonicalizeReference(p.reference) : null;
    return `${i + 1}. ${p.type} — ${[p.brand,p.model,shownReference].filter(Boolean).join(" ")}\n\nCurrent FS: ${pulse.fsCount}\nCurrent WTB: ${pulse.wtbCount}\n${pulse.averageFsAsk === null ? "Reference needed for exact pricing." : `Avg FS ask: ${formatAmount(String(Math.round(pulse.averageFsAsk)), "USD")}`}`;
  }));
  return `Your Market Briefing\n\n${cards.join("\n\n")}`;
}

async function handleMarketCommand(phone: string, briefing: boolean): Promise<string> {
  if (briefing) return formatMarketBriefing(phone);
  const rows = (await userListings(phone)).filter((p) => p.status === "active");
  if (rows.length !== 1) return chooseListingMessage(rows, "market data");
  const p = rows[0];
  if (!p.reference && !p.brand && !p.model) return "Reference needed for exact pricing.";
  return formatMarketPulse(await getScopedMarketPulse({ brand: p.brand, model: p.model, reference: p.reference }));
}

/** Runs a fresh search for `request`, showing Match Cards and arming them for approve/pass. */
async function startSearch(state: ConversationState, request: ItemRequest, messages: string[]): Promise<void> {
  await logSearchRequest(state.phone, request.action, request.query); // best-effort (catches its own errors internally)
  const hadExistingPending = Boolean(state.pendingMatches);
  // findMatchesHybrid only ever activates AI-assisted matching for the configured test phone
  // (see config.isAiMatchingEnabledForPhone) — every other contact gets exactly the plain
  // deterministic engine, unchanged.
  const results = await findMatchesHybrid(state.phone, request, config.trial.maxOptionsPerItem, state.preferences);
  if (results.length === 0) {
    // Required routing fix: "never delete a pending match merely because another search
    // starts" — an empty new search used to unconditionally clear state.pendingMatches, wiping
    // out an existing, still-undecided match set just because THIS search came back empty.
    // state.pendingMatches is left untouched here; only a search that actually finds results
    // replaces it (below).
    messages.push(`No live matches yet for "${request.query}" — I'll keep watching the network.`);
    console.log(`[router] new_search=true pending_match_preserved=${hadExistingPending}`);
    // Real reported gap: a "sell" search with nothing to match against just stopped there,
    // leaving the seller's message unused. There's no live automatic buyer-matching for a
    // self-reported listing yet, so instead of searching again next time, collect what Fi
    // actually needs to describe the item to a future buyer — see startSellIntake.
    if (request.action === "sell") {
      await startSellIntake(state, request, messages);
    }
    return;
  }

  // Comps-based price signal (Attractive/Fair/High vs. other active listings for the same
  // reference) — see matching/priceSignal.ts. FS results only; a no-op fetch when there's
  // nothing to signal.
  const signaled = await attachPriceSignals(results);
  // Automatic currency conversion (src/fx/) — native + converted display strings for a listing
  // with known currency info; a no-op (undefined) for one without. Converts to this contact's
  // own "Show prices in EUR"/"Use HKD as my preferred currency" choice when set, else the
  // config-wide DEFAULT_DISPLAY_CURRENCY.
  const withCurrency = await attachCurrencyDisplay(signaled, state.preferredDisplayCurrency);

  // Confirms each listing's detailUrl actually resolves before it's ever sent in a card —
  // a constructed WatchFacts URL isn't guaranteed to be a valid live page (wrong id, expired
  // listing, site-side error). An unreachable URL is dropped rather than sent broken; matching
  // itself (and the listing's own contactPhone) is completely unaffected either way.
  const validated: { listing: InventoryListing; explanation?: string; priceSignal?: PriceSignal; currencyDisplay?: CurrencyDisplay }[] =
    await Promise.all(
      withCurrency.map(async ({ listing, explanation, priceSignal, currencyDisplay }) => ({
        listing: { ...listing, detailUrl: await getValidatedListingUrl(listing.detailUrl) },
        explanation,
        priceSignal,
        currencyDisplay,
      }))
    );

  // Each card now ends with its own reply instructions (approve/photos/pass for an FS/seller
  // card, approve/pass for a WTB/buyer card) — see formatMatchCard — so there's no separate
  // shared footer message here anymore.
  validated.forEach(({ listing, explanation, priceSignal, currencyDisplay }, i) =>
    messages.push(formatMatchCard(listing, i, request.action, explanation, priceSignal, currencyDisplay))
  );
  // A fresh search intentionally starts its own new monitor/numbering (spec: "a new buy/sell
  // request starts a new monitor") — any prior pendingMatches is superseded here, but note that
  // is only reached once THIS search actually has results; an empty one never reaches this line
  // (see above), so an old undecided set is never destroyed by a search that found nothing.
  state.pendingMatches = { request, matches: validated.map((r) => r.listing), decisions: validated.map(() => "pending") };
  console.log(`[router] new_search=true pending_match_preserved=${hadExistingPending}`);
}

/** The highest-indexed still-"pending" entry — spec: "approve/pass without a number applies to
 *  the latest unresolved match." Null when every entry has already been decided. */
function findLatestPendingIndex(pending: { decisions: MatchDecision[] }): number | null {
  for (let i = pending.decisions.length - 1; i >= 0; i--) {
    if (pending.decisions[i] === "pending") return i;
  }
  return null;
}

/**
 * Handles an "approve <n>" / "pass <n>" reply against the currently pending match set.
 *
 * After the 3rd complimentary approval, further approvals are gated by the SAME shared
 * canonical-account usage v4's automatic-matching flow uses (postings/approvalUsage.ts) —
 * no plan assigned locks approving outright; a tier1/tier2 plan allows up to its rolling
 * 7-day weekly cap; tier3 or the legacy admin override is unlimited. This on-demand flow has
 * no real Postgres match row of its own (it's an ephemeral search result, not a persisted
 * posting pair), so its approvals are recorded with a NULL match_id — see
 * recordApprovalEventForPhone. No payment processor exists, so this is never a live charge;
 * an admin assigns the plan (POST /admin/entitlement/plan), never self-service. Passing/
 * monitoring stay unrestricted either way.
 */
async function handleDecision(state: ConversationState, decision: DecisionCommand, messages: string[], firstName: string): Promise<void> {
  const pending = state.pendingMatches!;

  let idx: number;
  if (decision.index !== null) {
    idx = decision.index - 1;
    if (idx < 0 || idx >= pending.matches.length) {
      messages.push(`I don't have a match #${decision.index} — pick a number from the list above.`);
      return;
    }
  } else {
    const latestPending = findLatestPendingIndex(pending);
    if (latestPending === null) {
      messages.push("You've already decided on all your current matches.");
      return;
    }
    idx = latestPending;
  }

  const displayIndex = idx + 1;
  const current = pending.decisions[idx];
  if (current !== "pending") {
    messages.push(`You already ${current} match #${displayIndex}.`);
    return;
  }

  if (decision.action === "pass") {
    pending.decisions[idx] = "passed";
    messages.push(`Passing on #${displayIndex}.`);
    return;
  }

  // Approving is the only thing metered against the trial/plan.
  const usage = await getApprovalUsage(state.phone);
  const gate = evaluateApprovalGate(usage);
  if (!gate.allowed) {
    messages.push(gate.reason === "no_plan" ? config.fiFlow.noPlanMessage : config.fiFlow.weeklyCapMessage(gate.plan, gate.weeklyLimit));
    return;
  }

  const approvedListing = pending.matches[idx];
  await recordApprovalEventForPhone(usage.canonicalUserId, gate.isComplimentary, approvedListing.item || approvedListing.description, {
    name: approvedListing.contactName || "them",
    phone: approvedListing.contactPhone,
  });
  pending.decisions[idx] = "approved";
  messages.push(formatMatchApproved(pending.matches[idx], idx));
  messages.push(config.fiFlow.escrowSuggestion);
  state.pendingEscrowOffer = true;

  if (gate.isComplimentary && usage.totalApproved + 1 === config.trial.maxApprovedMatches) {
    messages.push(config.fiFlow.conversionPitch(firstName));
  }
}

/**
 * "photos <n>" / "photo <n>" / "request photos <n>" — private side traffic on a pending FS/
 * seller match, never a decision: never touches approval usage (nothing here is metered
 * against the trial or weekly plan cap) and never closes or passes the match — the buyer can
 * still approve or pass at any time, before or after photos arrive. See matching/photoRequests.ts.
 */
async function handlePhotoRequest(state: ConversationState, index: number, messages: string[]): Promise<void> {
  const pending = state.pendingMatches!;
  const idx = index - 1;

  if (idx < 0 || idx >= pending.matches.length) {
    messages.push(`I don't have a match #${index} — pick a number from the list above.`);
    return;
  }
  // Photos only make sense on an FS/seller card — a "sell" search shows WTB buyers, who have
  // nothing to photograph.
  if (pending.request.action !== "buy") {
    messages.push("Photo requests are only available for items currently for sale.");
    return;
  }

  const outcome = await requestPhotosForMatch(state.phone, pending.matches[idx], index);
  if (outcome === "duplicate") {
    messages.push("Photos have already been requested. I'll send them when received.");
  } else if (outcome === "unavailable") {
    messages.push(`I don't have a way to reach the seller for #${index}, so I can't request photos for it.`);
  } else {
    messages.push(`Photo request sent for #${index} — I'll forward them here as soon as the seller replies.`);
  }
}

const PRICE_QUESTION = 'What\'s your price range? (e.g. "$5,000–$8,000", or say "any")';
const LOCATION_QUESTION = 'Any location preference? (city or country, or say "any")';
const DIAL_QUESTION = 'Preferred dial color? (or say "any")';
const CONDITION_QUESTION = "Condition preference — new, pre-owned, or any?";

/**
 * Collected once per contact, on their first search only (spec extension, not in v3 itself).
 * Walks price → location → dial color → condition one question at a time, then runs the
 * item request that triggered it. Later searches reuse `state.preferences` without re-asking.
 */
async function handlePreferenceAnswer(state: ConversationState, text: string, messages: string[]): Promise<void> {
  const pending = state.pendingPreferenceCollection!;
  state.preferences = state.preferences ?? {};

  if (pending.step === "price") {
    const range = parsePriceRange(text);
    state.preferences.priceMin = range?.min;
    state.preferences.priceMax = range?.max;
    state.preferences.priceCurrency = range ? detectCurrency(text) ?? undefined : undefined;
    pending.step = "location";
    messages.push(LOCATION_QUESTION);
    return;
  }
  if (pending.step === "location") {
    state.preferences.location = parseFreeformPreference(text);
    pending.step = "dial";
    messages.push(DIAL_QUESTION);
    return;
  }
  if (pending.step === "dial") {
    state.preferences.dialColor = parseFreeformPreference(text);
    pending.step = "condition";
    messages.push(CONDITION_QUESTION);
    return;
  }

  state.preferences.condition = parseFreeformPreference(text);
  state.preferencesCollected = true;
  const request = pending.request;
  state.pendingPreferenceCollection = undefined;
  messages.push("Got it — searching now.");
  await startSearch(state, request, messages);
}

/**
 * Fi Concierge Stage 3 (Conversational Orchestrator, first slice): a buyer/seller who already
 * stated everything in one message ("looking for a Daytona under 27k, black dial, pre-owned,
 * USA") should never be walked through the price → location → dial → condition interview below
 * anyway — that's exactly the "not natural language" complaint. Only attempted for the AI
 * matching test phone (config.isAiMatchingEnabledForPhone), so this never changes behavior —
 * or cost — for the rest of the population; every other contact keeps the interview unchanged.
 * Returns null on any AI failure/disabled state so the caller falls back to the interview,
 * preserving the mandatory-price-filter guarantee even when AI is down.
 */
async function tryNaturalLanguagePreferences(phone: string, text: string): Promise<SearchPreferences | null> {
  if (!isAiMatchingEnabledForPhone(phone)) return null;
  const interpreted = await interpretQuery(text);
  if (!interpreted) return null;
  return toSearchPreferences(interpreted);
}

/**
 * A request must always carry price, location, dial color, and condition — the same four
 * things the old step-by-step interview always collected — even when the natural-language path
 * above skipped straight to search. Returns the human-readable label for each one NOT found in
 * `prefs`, so the caller can ask for exactly what's missing, once, instead of either silently
 * proceeding with gaps or re-running the old one-question-at-a-time interview.
 */
function missingPreferenceFields(prefs: SearchPreferences): string[] {
  const missing: string[] = [];
  if (prefs.priceMin === undefined && prefs.priceMax === undefined) missing.push("budget");
  if (!prefs.location) missing.push("location");
  if (!prefs.dialColor) missing.push("dial color");
  if (!prefs.condition) missing.push("condition");
  return missing;
}

/** "What's your X?" / "What's your X and Y?" / "What's your X, Y, and Z?" */
function missingFieldsQuestion(missing: string[]): string {
  if (missing.length === 1) return `Just one more thing — what's your ${missing[0]}?`;
  const last = missing[missing.length - 1];
  const rest = missing.slice(0, -1).join(", ");
  return `Just need a couple more details — what's your ${rest} and ${last}?`;
}

/**
 * Merges whatever the follow-up reply's own AI interpretation found into `partial`, filling in
 * ONLY the fields that were actually missing — a field the original message already supplied is
 * never overwritten by a vaguer follow-up reply that didn't mention it at all.
 */
function mergeFollowUpPreferences(partial: SearchPreferences, fromReply: SearchPreferences): SearchPreferences {
  return {
    priceMin: partial.priceMin ?? fromReply.priceMin,
    priceMax: partial.priceMax ?? fromReply.priceMax,
    priceCurrency: partial.priceCurrency ?? fromReply.priceCurrency,
    location: partial.location ?? fromReply.location,
    dialColor: partial.dialColor ?? fromReply.dialColor,
    condition: partial.condition ?? fromReply.condition,
  };
}

/**
 * Handles the single follow-up reply after tryNaturalLanguagePreferences found a request
 * missing one or more of budget/location/dial color/condition. Only one round is ever asked —
 * whatever's still missing after this reply stays "no preference," the same as answering "any"
 * in the old interview, rather than looping indefinitely chasing a complete answer.
 */
async function handleNaturalFollowUpAnswer(state: ConversationState, text: string, messages: string[]): Promise<void> {
  const pending = state.pendingNaturalFollowUp!;
  if (/^\s*(?:any|no preference)\s*[.!]?\s*$/i.test(text)) {
    state.preferences = pending.partial;
    state.preferencesCollected = true;
    state.pendingNaturalFollowUp = undefined;
    await startSearch(state, pending.request, messages);
    return;
  }
  const interpreted = await interpretQuery(text);
  const merged = interpreted ? mergeFollowUpPreferences(pending.partial, toSearchPreferences(interpreted)) : pending.partial;

  const stillMissing = missingPreferenceFields(merged);
  if (stillMissing.length > 0) {
    state.pendingNaturalFollowUp = { request: pending.request, partial: merged, missing: stillMissing };
    messages.push(missingFieldsQuestion(stillMissing));
    return;
  }

  state.preferences = merged;
  state.preferencesCollected = true;
  const request = pending.request;
  state.pendingNaturalFollowUp = undefined;
  await startSearch(state, request, messages);
}

const SELL_DETAILS_QUESTION = "Tell me a bit more about what you're selling — brand, model, and reference number if you have it.";
const SELL_PRICE_QUESTION = "What's your asking price?";
const CONDITION_INTAKE_QUESTION = "What condition is it in? (new, unworn, or pre-owned)";
const BUY_CONDITION_QUESTION = "What condition do you prefer? (new, pre-owned, or any)";
const SELL_LOCATION_QUESTION = "Where is the watch located? (city or country)";
const BUY_LOCATION_QUESTION = "Any location preference? (city or country, or say any)";
const BUY_BUDGET_QUESTION = "What's your maximum budget?";
const DIAL_INTAKE_QUESTION = "Do you prefer the black dial, white dial, or either?";
const SELL_PHOTO_QUESTION = 'Would you like to attach a photo? Send it now, or reply "skip" or "no photo".';
/** "any"/"all"/"skip"/etc name no model at all -- used both at the dedicated model-intake step
 *  and for a "model any"/"model none" correction at confirm time, so the two paths treat the
 *  same words the same way rather than one clearing the model and the other literally storing
 *  the word "any" as though it were a real model name. */
const NO_MODEL_PREFERENCE = /^(?:any|all|skip|none|no|n\/a|unsure|not\s+sure|don'?t\s+know|do\s+not\s+know)$/i;

/**
 * One side of a price range. Both ends must independently look like MONEY -- a currency marker,
 * a "k" suffix, or comma thousands grouping -- so a hyphenated reference ("116500-0013") and a
 * year range ("2020-2022") can never be read as one.
 */
const RANGE_END = String.raw`(?:(?:HK|US|C|S|A|CN)?[$€£¥]|\b(?:USD|CAD|HKD|EUR|GBP|AED|SGD|AUD|JPY|CNY|RMB|CHF)\s*)\s*\d[\d,.]*\s*k?|\d[\d,.]*\s*k\b|\d{1,3}(?:,\d{3})+`;
/** "HK$800k-HK$900k", "$28,000 to $30,000", "28k – 30k". "/" is deliberately NOT a separator:
 *  "25,5usd/35,4cad" is one amount quoted in two currencies, not a range (see normalizePriceShorthand). */
const PRICE_RANGE = new RegExp(String.raw`(${RANGE_END})\s*(?:-|–|—|to|through)\s*(${RANGE_END})`, "i");

function extractListingRange(text: string): { low: number; high: number } | null {
  const m = text.match(PRICE_RANGE);
  if (!m) return null;
  const a = normalizePriceShorthand(m[1]);
  const b = normalizePriceShorthand(m[2]);
  if (a === null || b === null) return null;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

/** Private listing shorthand commonly omits a currency marker. Only accept a standalone
 * trailing amount, and never the already-identified reference, so 116500LN cannot become a
 * price while `... 28500` reliably does.
 *
 * When the text names a RANGE, which end to keep depends on what the number means to its
 * author, so the caller says: a WTB budget is a ceiling ("max"), and a buyer who writes
 * "HK$800k-HK$900k" will pay up to 900k -- keeping the floor was the live bug here, and it
 * silently hid every listing between the two figures. An FS ask is the price a seller is
 * willing to start at ("min"), so a range there keeps the low end and the listing stays visible
 * to every buyer who could actually transact on it. Absent a range both agree, and this is the
 * single marked-or-trailing amount as before. */
function extractListingAmount(text: string, reference: string | null, prefer: "max" | "min" = "max"): number | undefined {
  const range = extractListingRange(text);
  if (range) return prefer === "max" ? range.high : range.low;
  const marked = text.match(/(?:under|max(?:imum)?|budget|asking|price|for|up\s+to|(?:no\s+)?more\s+than|around|about|spend(?:ing)?|[$€£])(?:\s+is)?\s*[$€£]?\s*([\d,.]+\s*k?)/i);
  const trailing = text.match(/(?:^|\s)([\d,.]+\s*k?)\s*$/i);
  const raw = marked?.[1] ?? trailing?.[1];
  if (!raw || raw.toUpperCase() === reference?.toUpperCase()) return undefined;
  return normalizePriceShorthand(raw) ?? undefined;
}

const DIAL_COLORS = "black|white|blue|green|silver|champagne|grey|gray|salmon|panda";
/** Words that can follow a locative preposition without naming a place: "in stock", "in good
 *  condition", "in a black dial", "from 2019". A place is a proper noun or a known region. */
const NOT_A_PLACE = /^(?:stock|good|great|excellent|mint|new|used|full|box|papers|a|an|the|my|this|that|good|perfect|condition|\d)/i;
/** Filler that survives slot-stripping but never names a place. Used only for the dealer
 *  shorthand fallback ("max 25k Miami"), where the location is whatever is left over. */
const LEFTOVER_STOPWORDS = new Set(["with","w","and","but","or","spend","spending","more","than","up","around","about","under","over","max","maximum","budget","located","based","near","ship","shipping","to","in","from","at","of","only","please","pls","thanks","thank","you","ok","okay","hi","hello","hey","if","possible","preferably","ideally","dial","color","colour","condition","set","full","box","papers","paper"]);

/**
 * Where the buyer is, or wants the watch from — read the way people actually say it.
 *
 * Two forms. A locative phrase: "I'm in Miami", "located in Florida", "from Hong Kong", "based
 * in the UK" — the place is what follows the preposition up to the next clause boundary, and it
 * must read as a place (a proper noun or a known region, not "stock" or "a black dial"). Then
 * dealer shorthand, where the place is simply the last thing left once every other slot is
 * accounted for: "black 116500LN, used, max 25k, Miami". That fallback only runs for a message
 * that already names a product, so a bare interview answer ("daytona") can never be mistaken
 * for a place, and the extracted model is excluded from what counts as left over.
 */
function extractLocation(text: string, consumed: { model?: string; brand?: string }): string | undefined {
  const region = (raw: string) => (/^united states$/i.test(raw) || raw.toUpperCase() === "USA" ? "USA" : raw);
  // The preposition is matched loosely; the place itself is NOT — a proper noun keeps its
  // capitals, and a case-insensitive [A-Z] would run on through "Miami and don't want".
  const locative = text.match(/\b(?:in|from|located\s+in|based\s+in|near|out\s+of|ship(?:ping)?\s+to)\s+(?:the\s+)?([^,.;!?\n]+)/i);
  if (locative) {
    const clause = locative[1].trim();
    const place =
      clause.match(/^(?:US|USA|UK|UAE|EU|HK|Hong Kong|Singapore|Canada|Europe|United States)(?=\s|$)/i)?.[0] ??
      clause.match(/^[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3}/)?.[0];
    const raw = place?.trim();
    if (raw && !NOT_A_PLACE.test(raw) && !containsKnownBrand(raw) && looksLikePlace(raw) && !new RegExp(`^(?:${DIAL_COLORS})$`, "i").test(raw)) return region(raw);
  }
  // Dealer shorthand fallback: strip every recognised slot and see what is left. Only for a
  // FRESH REQUEST — one that states buy/sell intent and names a product by maker or reference.
  // Without that gate it fired on "change my budget to 32000" (the amount passes as a
  // five-digit "reference", leaving "change" as the place) and on a bare interview answer
  // like "NY 10001", which the location step already accepts whole.
  if (!BUY_KEYWORDS.test(text) && !SELL_KEYWORDS.test(text)) return undefined;
  const reference = extractReference(text);
  const amount = extractListingAmount(text, reference);
  const realReference = reference !== null && (amount === undefined || reference.replace(/\D/g, "") !== String(amount));
  if (!containsKnownBrand(text) && !realReference) return undefined;
  let leftover = text
    .replace(/\b(?:HK|US|C|S|A|CN)?[$€£¥]\s*[\d][\d,.]*\s*k?\b/gi, " ")
    .replace(/\b[\d][\d,.]*\s*k\b/gi, " ")
    .replace(/\b(?:USD|CAD|HKD|EUR|GBP|AED|SGD|AUD|JPY|CNY|RMB|CHF)\b/gi, " ")
    .replace(/\b(?:pre[- ]?owned|unworn|brand\s+new|used|new|mint|any\s+condition)\b/gi, " ")
    .replace(new RegExp(`\\b(?:${DIAL_COLORS}|either|any)\\s*(?:dials?|colou?rs?)?\\b`, "gi"), " ")
    .replace(/\b(?:full\s+set|box(?:\s+and\s+|\s*&\s*|\/)?papers?|papers)\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  for (const known of [extractReference(text), consumed.brand, consumed.model].filter((v): v is string => Boolean(v))) {
    leftover = leftover.replace(new RegExp(`\\b${known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  }
  const words = leftover.split(/[^A-Za-z'’]+/).filter((w) => w && !INTENT_TOKENS.has(w.toLowerCase().replace(/’/g, "'")) && !isOnlyNonModelLanguage(w) && !LEFTOVER_STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0 || words.length > 3) return undefined;
  const place = words.join(" ");
  return looksLikePlace(place) && !containsKnownBrand(place) ? region(place) : undefined;
}

/**
 * The dial, read from any of the ways a dealer writes it: "black dial", a bare colour right
 * beside the reference ("black 116500LN", "116500LN black,"), or a colour ending the identity
 * clause. A colour that is FOLLOWED by another word is left alone — "Black Bay" is a model.
 */
function extractDial(text: string, reference: string | null): string | undefined {
  const bare = text.match(new RegExp(`^\\s*(${DIAL_COLORS}|either|any)\\s*(?:dial|color)?\\s*$`, "i"))?.[1];
  if (bare) return bare.toLowerCase();
  const explicit = text.match(new RegExp(`\\b(${DIAL_COLORS}|either|any)\\s*(?:dial|colou?r)\\b`, "i"))?.[1];
  if (explicit) return explicit.toLowerCase();
  if (reference) {
    const ref = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const beside = text.match(new RegExp(`\\b(${DIAL_COLORS})\\s+${ref}\\b|\\b${ref}\\s+(${DIAL_COLORS})(?=[\\s,.;!?]|$)`, "i"));
    if (beside) return (beside[1] ?? beside[2]).toLowerCase();
  }
  return undefined;
}

function intakeSlots(text: string, reference: string | null, prefer: "max" | "min" = "max") {
  const price = extractListingAmount(text, reference, prefer);
  const conditionRaw = text.match(/\b(pre[- ]?owned|used|unworn|brand new|new|mint|any condition)\b/i)?.[1];
  const condition = conditionRaw && /^pre[- ]?owned$/i.test(conditionRaw) ? "pre-owned" : conditionRaw;
  const dial = extractDial(text, extractReference(text));
  const normalized=normalizeText(text);
  const brand=normalized.brand||undefined;
  // Once the maker is identified, a model can only be what FOLLOWS the brand in the identity
  // clause. Everything before it is conversational lead-in, and must never be stored as the
  // model — the live bug this fixes persisted "ot buy a" (the tail of "i want ot buy a rolex")
  // as the model, which then displayed as "Rolex ot buy a". When the brand is named somewhere
  // else in the message but not in this clause, the clause is entirely lead-in and yields no
  // model at all rather than a guess.
  // The identity clause ends where the description of the watch ends: at the first comma, at a
  // sentence boundary, or at "with"/"w/" introducing its details ("116500LN with a black dial").
  // The live bug this closes stored "Daytona  with aI'm" as the model, because only the comma
  // was ever treated as an end.
  let identityClause: string | null = stripLeadingIntent(text).split(/,|[.!?](?:\s|$)|\s+(?:with|w\/)\s+/i, 1)[0];
  if (brand) {
    const brandAt = identityClause.toLowerCase().indexOf(brand.toLowerCase());
    identityClause = brandAt >= 0 ? identityClause.slice(brandAt + brand.length) : null;
  }
  const itemPhrase=(identityClause ?? "")
    .replace(/^(?:it(?:'s| is)|this is)\s+(?:a\s+)?/i, "")
    .replace(new RegExp(`\\b${(brand??"").replace(/\s+/g,"\\s+")}\\b`,"i"), "")
    .replace(extractReference(text)??"","")
    // A dial-color word ("black dial") describes the dial, not the watch's model, but the
    // trailing cutoff below only ever removed "dial"/"color" itself, leaving the color word
    // sitting right in front of it — the live bug this fixes stored "black" as the model for
    // "wtb a rolex 116500 black dial" (displayed as "Model: black") even though the dial field
    // was already being parsed correctly from the same message. Removing the whole phrase here,
    // before that cutoff runs, also stops the cutoff from eating a model that FOLLOWS one:
    // "black dial daytona" keeps daytona instead of collapsing to the color.
    .replace(/\b(?:black|white|blue|green|silver|champagne|grey|gray|salmon|panda|either|any)\s*(?:dials?|colou?rs?)\b/gi, " ")
    // A bare colour that ENDS the clause is the dial, not part of the model ("116500LN black").
    .replace(new RegExp(`\\s+(?:${DIAL_COLORS})\\s*$`, "i"), " ")
    .replace(/\bonly\b/gi, "")
    // Same budget markers extractListingAmount understands — "around $25k" must not leave
    // "around" behind as the model any more than "under 25k" leaves "under". Replaced with a
    // single space, not "" — the real reported bug: this match's own \s* consumes the
    // whitespace on BOTH sides of the number, so removing it outright fused whatever word came
    // right before and right after ("... or 38000 preowned" -> "...orpreowned"), which then
    // defeated the very next cleanup step's \b word-boundary check for trailing condition words.
    // The stray double space this can leave behind is what the final \s+ -> " " collapse below
    // (in `scrubbed`) exists to clean up.
    .replace(/(?:under|max(?:imum)?|budget|asking|price|for|up\s+to|(?:no\s+)?more\s+than|around|about|spend(?:ing)?)?\s*[$€£]?\s*[\d,.]+\s*k?\b/gi, " ")
    .replace(/\b(?:pre[- ]?owned|used|unworn|brand new|new|mint|in|from|located|based|dial|color|full set|box|papers|USD|AED|HKD|EUR|GBP)\b.*$/i, "")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
  // Belt and braces: whatever survives the scrubbing above is still rejected outright if it
  // identifies nothing — lead-in language, or a descriptor like a dial color that already has
  // its own slot. No phrasing can round-trip either into the model.
  const reference_ = extractReference(text);
  // A reference alone is how dealers name a watch ("Need a black 116500LN"); the maker and
  // model it implies are filled in only when the message did not state them itself.
  const implied = reference_ ? identityForReference(reference_) : null;
  const resolvedBrand = brand ?? implied?.brand;
  const scrubbed = itemPhrase.replace(/\s+/g, " ").trim();
  const typedModel = brand && scrubbed && !isOnlyNonModelLanguage(scrubbed) ? scrubbed : undefined;
  // A model the user typed always wins. Otherwise the reference supplies it — "Rolex 116500LN"
  // is a Daytona whether or not the word appears — but never across a brand disagreement: a
  // stated brand the reference does not belong to gets no model attached to it.
  const model = typedModel ?? (implied && (!brand || brand === implied.brand) ? implied.model : undefined);
  const location = extractLocation(text, { brand: resolvedBrand, model });
  const boxPapers=/\b(full set|box(?: and | & |\/)?papers?|papers)\b/i.exec(text)?.[1]; const year=/\b(19\d{2}|20\d{2})\b/.exec(text)?.[1];
  return { reference: reference_, price, currency: price === undefined ? undefined : detectCurrency(text) ?? "USD", location, condition, dial,brand: resolvedBrand,model,boxPapers,year };
}

/**
 * Whether a free-text reply may be stored as a location.
 *
 * The location step used to accept ANY non-empty text, which is what let the live session store
 * "hi" as the buyer's location. A place is a short phrase of words: no digits or currency, not a
 * greeting, and not an account question. Anything else falls through to normal handling with the
 * draft left alone, rather than being absorbed into the field Fi happened to be asking about.
 */
function looksLikePlace(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60) return false;
  // Reject on specific signals only. An earlier version whitelisted letters-and-spaces instead,
  // which rejected real answers people actually send — "USA!", "NY 10001", "UK/EU" — and since
  // nothing else claims the location step, Fi re-asked the same question forever. Whatever the
  // customer sends IS their answer unless it is recognizably something else.
  if (BARE_GREETING.test(t)) return false;
  if (parseAccountIntent(t)) return false;
  // A bare amount answers a different question (a mistyped budget), never a place.
  if (/^[$€£]?\s*[\d,.]+\s*[km]?$/i.test(t)) return false;
  return true;
}

function dialRelevant(reference: string | null): boolean { return /^(116500LN|126500LN)$/i.test(reference ?? ""); }

function applySellSlots(p: PendingSellIntake, text: string): boolean {
  const s = intakeSlots(text, p.reference, "min"); let changed = false;
  if (s.reference) { p.reference = s.reference; changed = true; }
  if(s.brand){p.brand=s.brand;changed=true;} if(s.model){p.model=s.model;changed=true;} if(s.boxPapers){p.boxPapers=s.boxPapers;changed=true;} if(s.year){p.year=s.year;changed=true;}
  if (containsKnownBrand(text) || s.reference) { p.description = stripLeadingIntent(text); changed = true; }
  if (s.price !== undefined) { p.price = s.price; p.currency = s.currency; changed = true; }
  if (s.location) { p.location = s.location; changed = true; }
  if (s.condition) { p.condition = s.condition; changed = true; }
  if (s.dial) { p.dialColor = /^any$/i.test(s.dial) ? "either" : s.dial; changed = true; }
  return changed;
}
function applyBuySlots(p: PendingBuyIntake, text: string): boolean {
  const s = intakeSlots(text, p.reference); let changed = false;
  if (s.reference) { p.reference = s.reference; changed = true; }
  if(s.brand){p.brand=s.brand;changed=true;} if(s.model){p.model=s.model;changed=true;} if(s.boxPapers){p.boxPapers=s.boxPapers;changed=true;} if(s.year){p.year=s.year;changed=true;}
  if (containsKnownBrand(text) || s.reference) { p.description = stripLeadingIntent(text); changed = true; }
  if (s.price !== undefined) { p.budget = s.price; p.currency = s.currency; changed = true; }
  if (s.location) { p.location = s.location; changed = true; }
  if (s.condition) { p.condition = s.condition; changed = true; }
  if (s.dial) { p.dialColor = /^any$/i.test(s.dial) ? "either" : s.dial; changed = true; }
  return changed;
}

function looksLikePriceAnswer(text: string): boolean {
  const value = text.trim();
  if (/^(?:[$€£]|(?:USD|CAD|HKD|EUR|GBP|AED|SGD|JPY|CNY|RMB|CHF)\b)/i.test(value)) return true;
  if (/(?:USD|CAD|HKD|EUR|GBP|AED|SGD|JPY|CNY|RMB|CHF)\s*$/i.test(value)) return true;
  // Preserve common six-digit numeric manufacturer references (for example Rolex 116500),
  // while rejecting the reported ambiguous five-digit asking-price reply (38000).
  return /^\d{5}(?:[,.]\d+)?\s*[kK]?$/.test(value);
}

function applyNamedIdentityCorrections(p: PendingSellIntake | PendingBuyIntake, text: string): boolean {
  let changed = false;
  if (/\bbrand\b/i.test(text)) {
    const brand = normalizeText(text).brand;
    if (brand) { p.brand = brand; changed = true; }
  }
  // Connector ("to"/"is") is optional -- "make model 116500" and "set model 116500" name the
  // field just as plainly as "model is 116500", and the live-reported failure was exactly this
  // stricter form silently doing nothing ("I kept your request draft open."). A captured value
  // that's ENTIRELY a reference number ("model 116500") almost always means the reference in
  // this domain ("what's the model" colloquially asking for the ref), not a free-text name, so
  // it's routed there instead -- "model is Daytona" still names an actual model normally.
  const model = /\bmodel\b\s*(?:to|is|[:=])?\s*([^,.;]+)/i.exec(text)?.[1]?.trim();
  if (model) {
    // "model any"/"model none" clears it rather than literally storing the word "any" as a
    // model name -- the live-reported bug this fixes showed "Model: any" in the confirmation,
    // the exact same word the dedicated model-intake step already treats as no preference.
    if (NO_MODEL_PREFERENCE.test(model)) {
      p.model = undefined;
      // `"modelSkipped" in p` would only catch a PendingBuyIntake that ALREADY had it set (an
      // optional field absent from the object literal isn't an own key until first assigned) --
      // this is the one field WTB alone acts on (review()'s "Model: Any" display), so it's set
      // unconditionally rather than trying to detect which of the two intake types `p` is.
      (p as PendingBuyIntake).modelSkipped = true;
      changed = true;
    } else {
      const asReference = extractReference(model);
      if (asReference && normalizeReference(asReference) === normalizeReference(model)) { p.reference = asReference; changed = true; }
      else { p.model = model; changed = true; }
    }
  }
  if (/\b(?:reference|ref)\b/i.test(text)) {
    const reference = extractReference(text);
    if (reference && !looksLikePriceAnswer(reference)) { p.reference = reference; changed = true; }
  }
  return changed;
}

/**
 * "any" / "either" / "no preference" and friends: a bare qualifier names no field of its own,
 * so the only thing it can mean is "any <the thing Fi just asked about>". Routed by the step
 * being answered rather than pattern-matched into whichever field happens to accept the word.
 *
 * The live bug this fixes made the condition question unanswerable. Several fields accept the
 * same word — a bare "any" also satisfies the dial-color pattern — so answering "any" to
 * "What condition do you prefer?" silently set the DIAL instead, counted as a change, and the
 * only code that could set condition from it (a "nothing else matched" fallback) therefore
 * never ran. Fi asked the same question again, and would have done so forever; the reported
 * session escaped only by typing "preowned".
 *
 * The model step is deliberately not handled here — it has its own broader vocabulary
 * (NO_MODEL_PREFERENCE, which also accepts skip/none/unsure) and its own modelSkipped flag.
 */
const BARE_QUALIFIER = /^(?:any|anything|either|whatever|no\s+pref(?:erence)?|don'?t\s+care|doesn'?t\s+matter|not\s+fussed)\s*[.!]*$/i;

function applyBareQualifier(p: PendingSellIntake | PendingBuyIntake, text: string): boolean {
  if (!BARE_QUALIFIER.test(text.trim())) return false;
  if (p.step === "dial") { p.dialColor = "either"; return true; }
  if (p.step === "condition") { p.condition = "any"; return true; }
  if (p.step === "location") { p.location = "any"; return true; }
  return false;
}

/** Applies a reply only to the slot Fi asked for. Confirmation-time corrections are accepted
 * only when the field is named, preventing a price-only edit from ever touching identity. */
function applyScopedSellAnswer(p: PendingSellIntake, text: string): boolean {
  if (applyBareQualifier(p, text)) return true;
  if (/\b(?:change|update|make|set)\b[\s\S]*\b(?:price|asking)\b|\b(?:price|asking)\b[\s\S]*\b(?:to|is)\b/i.test(text)) {
    const price = extractListingAmount(text, p.reference, "min");
    if (price === undefined) return false;
    p.price = price; p.currency = detectCurrency(text) ?? p.currency ?? "USD";
    const slots = intakeSlots(text, p.reference);
    if (slots.condition) p.condition = slots.condition;
    if (slots.dial) p.dialColor = slots.dial;
    if (slots.location) p.location = slots.location;
    return true;
  }
  if (p.step === "price") {
    const price = extractListingAmount(text, p.reference, "min");
    if (price === undefined) return false;
    p.price = price; p.currency = detectCurrency(text) ?? p.currency ?? "USD"; return true;
  }
  if (p.step === "details" && /^\s*\d{6}\s*$/.test(text)) {
    p.reference = text.trim();
    return true;
  }
  if (p.step === "confirm") {
    let changed = false;
    if (/\b(?:price|asking)\b/i.test(text)) {
      const price = extractListingAmount(text, p.reference, "min"); if (price !== undefined) { p.price = price; p.currency = detectCurrency(text) ?? p.currency ?? "USD"; changed = true; }
    }
    changed = applyNamedIdentityCorrections(p, text) || changed;
    const slots = intakeSlots(text, p.reference);
    if (slots.condition) { p.condition = slots.condition; changed = true; }
    if (slots.dial) { p.dialColor = slots.dial; changed = true; }
    if (slots.location) { p.location = slots.location; changed = true; }
    return changed;
  }
  // A location answer is a location and nothing else. Falling through to the full slot parser
  // re-read the reply as item identity: "NY 10001" has a reference-shaped token in it, so the
  // draft's description and reference were both overwritten with the customer's own postcode.
  // Returning false here leaves the plain free-text place to the caller's freeLocation path.
  if (p.step === "location") {
    const slots = intakeSlots(text, p.reference);
    if (slots.location) { p.location = slots.location; return true; }
    return false;
  }
  if (p.step === "details" && looksLikePriceAnswer(text)) return false;
  return applySellSlots(p, text);
}

function applyScopedBuyAnswer(p: PendingBuyIntake, text: string): boolean {
  if (applyBareQualifier(p, text)) return true;
  if (/\b(?:change|update|make|set)\b[\s\S]*\b(?:price|budget|maximum|max)\b|\b(?:price|budget|maximum|max)\b[\s\S]*\b(?:to|is)\b/i.test(text)) {
    const budget = extractListingAmount(text, p.reference);
    if (budget === undefined) return false;
    p.budget = budget; p.currency = detectCurrency(text) ?? p.currency ?? "USD";
    const slots = intakeSlots(text, p.reference);
    if (slots.condition) p.condition = slots.condition;
    if (slots.dial) p.dialColor = slots.dial;
    if (slots.location) p.location = slots.location;
    return true;
  }
  if (p.step === "budget") {
    const budget = extractListingAmount(text, p.reference);
    if (budget === undefined) return false;
    p.budget = budget; p.currency = detectCurrency(text) ?? p.currency ?? "USD"; return true;
  }
  // "any"/"all" explicitly broadens the search to every model of the brand rather than naming
  // one -- matching (postings/matching.ts's scoreMatch) already treats a WTB with a brand but no
  // reference as matching ANY same-brand FS listing, so this is enough to satisfy "send me all
  // Rolex models under that price" once the request is confirmed and monitoring starts.
  if (p.step === "model") {
    const t = text.trim();
    if (NO_MODEL_PREFERENCE.test(t)) { p.modelSkipped = true; return true; }
    if (!t || isOnlyNonModelLanguage(t)) return false;
    p.model = t.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
    return true;
  }
  if (p.step === "details" && /^\s*\d{6}\s*$/.test(text)) {
    p.reference = text.trim();
    return true;
  }
  if (p.step === "confirm") {
    let changed = false;
    if (/\b(?:price|budget|maximum|max)\b/i.test(text)) {
      const budget = extractListingAmount(text, p.reference); if (budget !== undefined) { p.budget = budget; p.currency = detectCurrency(text) ?? p.currency ?? "USD"; changed = true; }
    }
    changed = applyNamedIdentityCorrections(p, text) || changed;
    const slots = intakeSlots(text, p.reference);
    if (slots.condition) { p.condition = slots.condition; changed = true; }
    if (slots.dial) { p.dialColor = slots.dial; changed = true; }
    if (slots.location) { p.location = slots.location; changed = true; }
    return changed;
  }
  // A location answer is a location and nothing else. Falling through to the full slot parser
  // re-read the reply as item identity: "NY 10001" has a reference-shaped token in it, so the
  // draft's description and reference were both overwritten with the customer's own postcode.
  // Returning false here leaves the plain free-text place to the caller's freeLocation path.
  if (p.step === "location") {
    const slots = intakeSlots(text, p.reference);
    if (slots.location) { p.location = slots.location; return true; }
    return false;
  }
  if (p.step === "details" && looksLikePriceAnswer(text)) return false;
  return applyBuySlots(p, text);
}
function nextSell(p: PendingSellIntake): string | null {
  if (!p.brand && !p.reference) { p.step="details"; return SELL_DETAILS_QUESTION; }
  if (!p.reference && !p.referenceSkipped) { p.step="details"; return "Do you have the reference number? You can reply skip if you don't know it."; }
  if (p.price === undefined) { p.step="price"; return SELL_PRICE_QUESTION; }
  if (dialRelevant(p.reference) && !p.dialColor) { p.step="dial"; return "Is it the black dial, white dial, or another color?"; }
  if (!p.condition) { p.step="condition"; return CONDITION_INTAKE_QUESTION; }
  if (!p.location) { p.step="location"; return SELL_LOCATION_QUESTION; }
  if (!p.imageUrl && !p.photoSkipped) { p.step="photo"; return SELL_PHOTO_QUESTION; }
  p.step="confirm"; return null;
}
function nextBuy(p: PendingBuyIntake): string | null {
  if (!p.brand && !p.reference) { p.step="details"; return "What would you like to buy? Please include the brand and model."; }
  if (p.budget === undefined) { p.step="budget"; return BUY_BUDGET_QUESTION; }
  // Only asked when NOTHING beyond brand/budget is known yet -- a message that already answered
  // condition or location too clearly front-loaded everything it means to give, and re-asking
  // for a model it never mentioned would contradict that (the live-tested contract: a fully
  // detailed message goes straight to confirmation, no back-and-forth). Live-reported gap this
  // closes: "wtb rolex" alone never got asked for a model at all -- it silently confirmed with
  // "Model: Not provided" with no chance to say "any" and broaden the search on purpose.
  if (!p.model && !p.modelSkipped && !p.reference && !p.condition && !p.location) {
    p.step = "model";
    return `Which model? (or say "any" to consider all ${displayBrand(p.brand) || "matching"} models under your budget)`;
  }
  if (dialRelevant(p.reference) && !p.dialColor) { p.step="dial"; return DIAL_INTAKE_QUESTION; }
  if (!p.condition) { p.step="condition"; return BUY_CONDITION_QUESTION; }
  if (!p.location) { p.step="location"; return BUY_LOCATION_QUESTION; }
  p.step="confirm"; return null;
}
function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
/**
 * Real reported gap: a typo on the exact word Fi just asked for ("Reply CONFIRM to start
 * monitoring") fell through to "I didn't understand," even though the intent was obvious.
 * Tolerates a single-character edit on "confirm" specifically — the one word every intake
 * confirmation step explicitly instructs the user to reply with — not the other, shorter
 * keywords below, which are too collision-prone for fuzzy matching (a 1-edit typo of "ok" or
 * "yes" can land on a real, unrelated word).
 */
const confirmed = (text: string) => {
  const trimmed = text.trim();
  if (/^(yes|yep|yeah|confirm|correct|sure|ok(?:ay)?|start|do it)\b/i.test(trimmed)) return true;
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  return firstWord.length >= 5 && levenshteinDistance(firstWord, "confirm") === 1;
};
const cash = (n: number, c = "USD") => `${c === "USD" ? "$" : c+" "}${n.toLocaleString("en-US")}`;
// The one-line summary names the WATCH, not the sentence it arrived in. Echoing the whole
// message back ("I have: WTB pre-owned Rolex Daytona 116500LN with a black dial. I'm in Miami
// and don't want to spend more than $25,000., black dial, pre-owned, Miami, maximum $25,000")
// repeats every detail twice and reads as if Fi did not understand it. The stored description
// is untouched — it remains the customer's own words.
const identityLine=(p:PendingSellIntake|PendingBuyIntake)=>[displayBrand(p.brand),p.model,p.reference].filter(Boolean).join(" ")||p.description;
// The review states each fact once, on its own line, and asks its one question once. The
// block it replaces opened with a sentence that repeated every field, then listed the fields
// again under a "listing review" heading with "Not provided" placeholders, and asked "Should I
// start monitoring?" twice. Fields the customer did not give are simply absent; a model they
// explicitly waived ("any") is said, because that is a decision, not a gap.
const capitalize=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const review=(type:string,p:PendingSellIntake|PendingBuyIntake,price:number)=>{
  const anyModel="modelSkipped" in p&&p.modelSkipped&&!p.model;
  return [
    "I have:",
    `${type} — ${identityLine(p)}${anyModel?" (any model)":""}`,
    p.dialColor&&`${capitalize(p.dialColor)} dial`,
    p.condition&&capitalize(p.condition),
    `${type==="FS"?"Asking":"Maximum"}: ${cash(price,p.currency)}`,
    p.location&&`Location: ${p.location}`,
    p.boxPapers&&`Box/Papers: ${p.boxPapers}`,
    p.year&&`Year: ${p.year}`,
    `Photo: ${"imageUrl" in p&&p.imageUrl?"attached":"none"}`,
    "",
    "Should I start monitoring?",
    "Reply CONFIRM to start monitoring, or send a correction.",
  ].filter((line): line is string => typeof line === "string").join("\n");
};
const sellSummary = (p: PendingSellIntake) => review("FS",p,p.price!);
const buySummary = (p: PendingBuyIntake) => review("WTB",p,p.budget!);

/**
 * A "sell" request has no live automatic buyer-matching wired up yet — there's nothing to
 * search against for a self-reported listing (unlike "buy", which searches WatchFacts' own
 * synced FS inventory directly). Real reported gap: "I want to sell a watch" ran a doomed
 * search for the literal word "watch" and reported "no matches" instead of collecting what
 * Fi actually needs to describe the item to a future buyer. Skips straight to the price
 * question when the message already names a reference or a known brand — "116500 white dial"
 * doesn't need to be asked "tell me more" when it's already specific.
 */
async function startSellIntake(state: ConversationState, request: ItemRequest, messages: string[], originalText = request.query, imageUrl?: string, suppliedCondition?: string, suppliedLocation?: string): Promise<void> {
  const p: PendingSellIntake = {
    step:"details", description:request.query, reference:extractReference(request.query),
    ...(suppliedCondition !== undefined ? { condition: suppliedCondition } : {}),
    ...(suppliedLocation !== undefined ? { location: suppliedLocation } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
  };
  applySellSlots(p, originalText); state.pendingSellIntake=p; messages.push(nextSell(p) ?? sellSummary(p));
}

async function startBuyIntake(state: ConversationState, request: ItemRequest, messages: string[], originalText: string, suppliedCondition?: string, suppliedLocation?: string): Promise<void> {
  const p: PendingBuyIntake = {
    step:"details", description:request.query, reference:extractReference(request.query),
    ...(suppliedCondition !== undefined ? { condition: suppliedCondition } : {}),
    ...(suppliedLocation !== undefined ? { location: suppliedLocation } : {}),
  };
  applyBuySlots(p, originalText); state.pendingBuyIntake=p; messages.push(nextBuy(p) ?? buySummary(p));
}

/**
 * Persists the finished intake as a live FS inventory row — see watchfacts/inventoryDb.ts's
 * upsertListings — so a future buyer's search can actually find it, not just a conversation-
 * state record that nothing else ever reads. Uses a distinct source ("WA-DM": a private
 * seller's own WhatsApp DM, as opposed to "WF"/WatchFacts or "WA-Group"/monitored dealer
 * groups) so nothing else's sync reconciliation ever touches or expires it — a private listing
 * stays active until the seller says otherwise.
 */
async function persistSellIntake(state: ConversationState, pending: PendingSellIntake): Promise<void> {
  const { brand } = normalizeText(pending.description);
  await upsertListings(
    [
      {
        id: `wadm-${state.phone}-${Date.now()}`,
        type: "FS",
        category: "watches",
        item: pending.description,
        brand,
        ref: pending.reference ?? "",
        condition: pending.condition ?? "",
        price: pending.price !== undefined ? String(pending.price) : "ASK",
        location: pending.location ?? "",
        contactName: "",
        contactPhone: state.phone,
        rating: "",
        description: pending.description,
        imageUrl: pending.imageUrl,
      },
    ],
    new Date().toISOString(),
    "WA-DM"
  );
}

/** Walks details -> price -> photo, one question at a time, then acknowledges — never loops
 *  back to re-ask a step; whatever's given (including nothing) is accepted and it moves on,
 *  same "ask once" principle as the rest of this file's collectors. The final "photo" step both
 *  quietly archives the listing (persistSellIntake, v3's inventory_listings — searchable by a
 *  future buyer's own "buy:" search, same as any other passively-captured listing) and creates
 *  a real v4 FS posting run against every active WTB posting immediately (see postings/ingest.ts's
 *  ingestDirectSellPosting) — the acknowledgment reflects whether that immediate search actually
 *  found a live buyer, rather than a blanket "not wired up yet" caveat. */
async function handleSellIntakeAnswer(state: ConversationState, text: string, imageUrl: string | undefined, messages: string[], contact?: Contact): Promise<void> {
  const p=state.pendingSellIntake!; const suppliedPhoto = Boolean(imageUrl); if(imageUrl)p.imageUrl=imageUrl;
  if(p.step==="confirm" && confirmed(text)){ await persistSellIntake(state,p); const result=await ingestDirectSellPosting({phone:state.phone,senderName:contact?.name,description:p.description,brand:p.brand,model:p.model,reference:p.reference,price:p.price!,currency:p.currency,dialColor:p.dialColor,condition:p.condition,location:p.location,boxPapers:p.boxPapers,year:p.year,notes:p.notes,imageUrl:p.imageUrl}); messages.push(formatActiveAcknowledgment(result.posting,result.matchesFound)); state.pendingSellIntake=undefined; await maybeNudgeChannelPreference(state,messages); return; }
  const skippedPhoto = p.step === "photo" && /^(?:skip|no\s+photo|none)$/i.test(text.trim());
  if (skippedPhoto) p.photoSkipped = true;
  const skippedReference=p.step==="details"&&!p.reference&&/^(?:skip|no|none|don't know|do not know)$/i.test(text.trim()); if(skippedReference)p.referenceSkipped=true;
  if (/\?/.test(text)) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I can help with that while keeping your listing draft open."); messages.push(nextSell(p)??sellSummary(p)); return; }
  // The scoped answer runs FIRST, and free-text location is only the fallback for what it did
  // not claim. Computing them independently meant a message the scoped answer had already
  // handled was ALSO stored as the location: "change my price to 32000", sent while the draft
  // was waiting on a location, correctly repriced the draft and then set its location to the
  // whole sentence.
  const scopedChange=applyScopedSellAnswer(p,text);
  const freeLocation=!scopedChange&&p.step==="location"&&!intakeSlots(text,p.reference).location&&looksLikePlace(text);
  if(freeLocation)p.location=text.trim();
  const changed=scopedChange || suppliedPhoto || skippedPhoto || skippedReference || freeLocation;
  if (!changed && p.step === "details" && looksLikePriceAnswer(text)) { messages.push("That looks like a price, not a reference number. Please send the manufacturer reference, or reply skip."); return; }
  if(!changed) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I kept your listing draft open."); }
  messages.push(nextSell(p)??sellSummary(p));
}

async function handleBuyIntakeAnswer(state: ConversationState, text: string, messages: string[], contact?: Contact): Promise<void> {
  const p=state.pendingBuyIntake!;
  if(p.step==="confirm" && confirmed(text)){ const result=await ingestDirectBuyPosting({phone:state.phone,senderName:contact?.name,description:p.description,brand:p.brand,model:p.model,modelSkipped:p.modelSkipped,reference:p.reference,price:p.budget!,currency:p.currency,dialColor:p.dialColor,condition:p.condition,location:p.location}); messages.push(formatActiveAcknowledgment(result.posting,result.matchesFound));
    // Confirmation is the activation boundary: show what WatchFacts already has for this exact
    // request rather than making the buyer ask a second time. Runs before the draft is cleared,
    // so the search is scoped to the request they just confirmed.
    messages.push(await handleCurrentInventoryCommand(state,"show current listings"));
    state.pendingBuyIntake=undefined; await maybeNudgeChannelPreference(state,messages); return; }
  if (/\?/.test(text)) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I can help with that while keeping your request draft open."); messages.push(nextBuy(p)??buySummary(p)); return; }
  const skippedReference=p.step==="details"&&!p.reference&&/^(?:skip|no|none|don't know|do not know)$/i.test(text.trim()); if(skippedReference)p.referenceSkipped=true;
  // See the sell handler above: the scoped answer claims the message first, and only what it
  // leaves unclaimed can become a free-text location.
  const scopedChange=applyScopedBuyAnswer(p,text);
  const freeLocation=!scopedChange&&p.step==="location"&&!intakeSlots(text,p.reference).location&&looksLikePlace(text);
  if(freeLocation)p.location=text.trim();
  const changed=scopedChange||skippedReference||freeLocation;
  if (!changed && p.step === "details" && looksLikePriceAnswer(text)) { messages.push("That looks like a price, not a reference number. Please send the manufacturer reference, or reply skip."); return; }
  if(!changed) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I kept your request draft open."); }
  messages.push(nextBuy(p)??buySummary(p));
}

interface ResolvedItems {
  items: ItemRequest[];
  /** Set only when `items` came from the AI intent extractor — its own price/location/dial/
   *  condition fields, straight from the SAME call, so the legacy interview/tryNaturalLanguage-
   *  Preferences path (a second, separate AI call) never has to re-derive them. */
  aiPreferences?: SearchPreferences;
  /** Set when the model claimed a price that couldn't be verified against the raw message's
   *  own unambiguous price pattern (see ai/intentExtractor.ts) — the caller shows "Price: Not
   *  reliably parsed" rather than silently searching with no budget filter and no explanation. */
  priceUnreliable?: boolean;
}

/**
 * Required routing order, items 2-3: every private message is sent through the AI intent
 * extractor first (when AI matching is enabled for this phone — see
 * config.isAiMatchingEnabledForPhone); the legacy regex classifier (classify/parseItemRequests)
 * is used ONLY as a fallback — when AI is disabled for this phone, the call fails, or the model
 * isn't confident it identified a genuine buy/sell intent. When AI succeeds, its own
 * brand/model/reference/searchText fields are used directly — never re-derived from the raw
 * sentence with a prefix-stripping regex (the actual cause of "to buy a patek 5712G" ending up
 * as a stored search query).
 */
async function resolveItemRequests(phone: string, text: string): Promise<ResolvedItems> {
  if (isAiMatchingEnabledForPhone(phone)) {
    const extraction = await extractIntent(text);
    if (extraction && isConfidentIntent(extraction) && (extraction.intent.intent === "buy" || extraction.intent.intent === "sell")) {
      const it = extraction.intent;
      const action: ItemRequest["action"] = it.intent === "buy" ? "buy" : "sell";
      const query = it.searchText || text;
      const aiPreferences: SearchPreferences = {};
      if (it.priceMin !== null) aiPreferences.priceMin = it.priceMin;
      if (it.priceMax !== null) aiPreferences.priceMax = it.priceMax;
      if (it.location) aiPreferences.location = it.location;
      if (it.dial) aiPreferences.dialColor = it.dial;
      if (it.condition) aiPreferences.condition = it.condition;
      return {
        items: [{ action, query }],
        aiPreferences,
        priceUnreliable: extraction.priceUnreliable,
      };
    }
    // AI unavailable/unconfident/not a buy-or-sell intent — legacy parser is the fallback, per
    // routing order item 3, same as every non-AI-enabled phone gets unconditionally.
  }
  return { items: parseItemRequests(text) };
}

export async function handleIncomingMessage(phone: string, text: string, contact?: Contact, imageUrl?: string): Promise<FlowResult> {
  const state = getState(phone);
  const messages: string[] = [];
  const firstName = contact?.name?.trim().split(/\s+/)[0] || "there";
  // Telegram commonly prefixes bot commands with "/" (and may append "@botname"). Keep one
  // normalized deterministic-command surface across Telegram, WhatsApp, and SMS.
  const commandText = text.trim().replace(/^\/([a-z]+)(?:@[a-z0-9_]+)?\b/i, "$1");

  // Checked before absolutely anything else that might touch this identity's canonical user
  // (getState above is the file-based conversation store, not that — it's safe). Linking must
  // attach the identity SENDING this message to the EXISTING canonical user the code names,
  // never let some other command create it a fresh, unrelated one first.
  const linkCode = commandText.trim().match(LINK_CODE_COMMAND);
  if (linkCode) {
    await handleLinkCodeCommand(phone, linkCode[1], messages);
    return { state, messages };
  }

  // START is a universal conversational reset, not only an opt-out recovery command. A user
  // with old pending matches must be able to begin again instead of being trapped behind the
  // approve/pass reminder shown in the reported live conversation.
  if (normalize(commandText) === "start") {
    const slashStart = /^\/start(?:@[a-z0-9_]+)?\b/i.test(text.trim());
    state.stage = "active";
    state.pendingMatches = undefined;
    state.pendingPreferenceCollection = undefined;
    state.pendingNaturalFollowUp = undefined;
    state.pendingSellIntake = undefined;
    state.pendingBuyIntake = undefined;
    state.pendingReplacementRequest = undefined;
    saveState(state);
    return {
      state,
      messages: [
        slashStart
          ? config.fiFlow.introMessage
          : "Hi, I'm Fi — here's what I can do: tell me naturally what you're looking to buy or sell, or ask me anything about your listings.",
      ],
    };
  }

  if (isOptOut(text)) {
    state.stage = "opted_out";
    saveState(state);
    return { state, messages: [...messages, "You're unsubscribed — you won't hear from Fi again. Reply START anytime to opt back in."] };
  }

  if (state.stage === "opted_out") {
    if (normalize(text) === "start") {
      state.stage = "new";
    } else {
      return { state, messages: [] };
    }
  }

  const upgradeMatch = /^upgrade(?:\s+(tier1|tier2|tier3))?$/i.exec(text.trim());
  if (/^join$/i.test(text.trim()) || upgradeMatch) {
    // "join" always means tier1 (the plan conversionPitch/noPlanMessage advertise); "upgrade"
    // with no tier shows the picker below rather than assuming one.
    const requestedPlan: PlanKey | null = /^join$/i.test(text.trim())
      ? "tier1"
      : upgradeMatch![1]
      ? (upgradeMatch![1].toLowerCase() as PlanKey)
      : null;

    if (requestedPlan && isAuthorizeNetConfigured()) {
      // The real path: a live, hosted checkout link (see billing/authorizeNet.ts + GET /pay/:id
      // in server.ts) that activates the membership automatically once Authorize.net confirms
      // payment — no admin step in between.
      const session = await createCheckoutSession(state.phone, requestedPlan);
      const planDef = MEMBERSHIP_PLANS[requestedPlan];
      state.hired = true;
      saveState(state);
      return {
        state,
        messages: [
          `Here's your secure payment link for ${planDef.label} (${planDef.priceLabel}):\n${config.publicBaseUrl}/pay/${session.id}\n\n` +
            `Once payment goes through I'll unlock your membership automatically — no need to message me again.`,
        ],
      };
    }

    if (!requestedPlan) {
      // Bare "upgrade" — show the tiers roomier than whatever the account currently has.
      const entitlement = await getEntitlement(state.phone);
      // Roomier tiers ONLY. This used to list every other tier, so a tier2 member asking to
      // upgrade was offered tier1 — a downgrade, presented as an upgrade. Matches the same
      // filter config.fiFlow.weeklyCapMessage already applies when it says the same thing.
      const currentLimit = entitlement.plan ? MEMBERSHIP_PLANS[entitlement.plan].weeklyLimit : 0;
      const options = (Object.values(MEMBERSHIP_PLANS) as (typeof MEMBERSHIP_PLANS)[PlanKey][])
        .filter((p) => p.key !== entitlement.plan && (currentLimit === null ? false : p.weeklyLimit === null || p.weeklyLimit > currentLimit))
        .map((p) => `Reply "upgrade ${p.key}" for ${p.label} (${p.priceLabel}${p.weeklyLimit === null ? ", unlimited" : `, ${p.weeklyLimit}/week`})`)
        .join("\n");
      return { state, messages: [options || "You're already on our top tier."] };
    }

    // No live payment processor configured yet — not a self-service unlock. Records intent for
    // an admin to review; only POST /admin/entitlement/plan actually assigns a plan in that case.
    await recordBillingRequested(state.phone);
    state.hired = true; // informational only now — reflects "has asked to join", not entitlement
    saveState(state);
    return {
      state,
      messages: [
        "Thanks — I've noted that you'd like to keep working with Fi. Our team will review your account, and you'll be able to approve more matches as soon as that's turned on.",
      ],
    };
  }

  // Required routing order (Fi NLU/routing fix): deterministic action commands — approve, pass,
  // photos, cancel, status, help — are ALL checked before anything else, unconditionally, so
  // none of them ever depends on AI, and none of them can be blocked by a mid-interview question
  // or a pending match. "hi"/"hello"/"menu" are folded into "help" (spec: "'hi' should return
  // the Fi menu, not force approve/pass").
  if (MENU_COMMAND.test(commandText)) {
    messages.push(FI_MENU);
    saveState(state);
    return { state, messages };
  }
  // Account questions and bare greetings are about the conversation, never about the draft Fi
  // is collecting, so they are answered here — before any pending-intake handling — and return
  // without saveState, which round-trips through JSON and would drop the draft's explicitly
  // undefined fields.
  const accountIntent = parseAccountIntent(commandText);
  if (accountIntent === "membership") {
    await handleMembershipCommand(state, messages);
    return { state, messages };
  }
  if (accountIntent === "status") {
    await handleStatusCommand(state, messages);
    return { state, messages };
  }
  // A brand-new contact's first "hi" must still reach onboarding (see state.stage === "new"
  // below), so this only claims a greeting once that has already happened. The live bug: with a
  // WTB draft open at its location step, "hi" was accepted as the buyer's location.
  if (state.stage !== "new" && BARE_GREETING.test(commandText.trim())) {
    const unresolved = state.pendingMatches?.decisions.filter((d) => d === "pending").length ?? 0;
    const canned = unresolved > 0
      ? 'Reply "approve <number>" or "pass <number>" for one of the matches above, or tell me a new item to search.'
      : `Hi ${firstName}, how can I help you today?`;
    const aiReply = isAiChatEnabled() ? await generateGeneralChatReply(text, unresolved) : null;
    messages.push(aiReply ?? canned);
    return { state, messages };
  }

  const listingEdit = parseListingEditCommand(commandText);
  // A command that names a listing number — one, or several ("close listing 1 and 2") — is
  // unambiguous and always wins. One that names NONE is ambiguous while an intake draft is open:
  // mid interview, "change my budget to 32000" is a correction to the draft Fi is collecting,
  // not a command about a stored listing, so it is left for the intake handler below.
  // "close all listings" names every listing just as unambiguously as a specific number would --
  // without also checking `all` here, it would read as naming NONE (index null, no indices) and
  // fall to the open draft's answer handler whenever one was open, the exact bug the "all" form
  // was added to fix.
  const namesAListing = Boolean(listingEdit && (listingEdit.index !== null || listingEdit.indices?.length || listingEdit.all));
  if (listingEdit && (namesAListing || !(state.pendingBuyIntake || state.pendingSellIntake))) {
    messages.push(await handleListingEdit(state.phone, listingEdit));
    // Listing edits are persisted by the postings store. Do not re-save the unrelated
    // conversation state here: JSON serialization drops explicitly-undefined intake fields,
    // which makes a management-only command silently rewrite an in-progress draft.
    return { state, messages };
  }
  if (CANCEL_COMMAND.test(text.trim())) {
    handleCancelCommand(state, messages);
    saveState(state);
    return { state, messages };
  }
  if (MY_ACTIVE_LISTINGS_COMMAND.test(text.trim())) {
    messages.push(await formatMyListingsSummary(state.phone));
    // This is a read-only postings view and must not normalize unrelated draft state.
    return { state, messages };
  }
  const marketReference = parseMarketReferenceCommand(commandText);
  if (marketReference) {
    messages.push(formatMarketPulse(await getScopedMarketPulse({ brand: displayBrand(marketReference.brand) || undefined, reference: marketReference.reference })));
    // Read-only, and deliberately not persisted: saveState round-trips through JSON, which
    // drops explicitly-undefined intake fields — a market lookup must not rewrite an open draft.
    return { state, messages };
  }
  if (MARKET_OVERVIEW_COMMAND.test(commandText)) {
    messages.push(formatNetworkMarketSnapshot(await getNetworkMarketSnapshot()));
    return { state, messages };
  }
  if (MARKET_COMMAND.test(commandText)) {
    messages.push(await handleMarketCommand(state.phone, MARKET_BRIEFING_COMMAND.test(commandText)));
    return { state, messages };
  }
  if (CURRENT_INVENTORY_COMMAND.test(text.trim())) {
    messages.push(await handleCurrentInventoryCommand(state, text));
    saveState(state);
    return { state, messages };
  }
  if (MORE_COMMAND.test(text.trim())) {
    const userId=await getOrCreateCanonicalUser(platformForIdentity(phone),phone);
    messages.push(await formatMoreResults(userId));
    saveState(state);
    return {state,messages};
  }
  // Listing-summary requests must remain deterministic: the general-chat model has no access
  // to the user's approved, pending, or active listings and must never invent that data.
  if (LISTINGS_COMMAND.test(text.trim())) {
    messages.push(LISTINGS_MENU);
    state.pendingListingsMenu = true;
    saveState(state);
    return { state, messages };
  }
  const currencyPreference = parseCurrencyPreferenceCommand(text);
  if (currencyPreference) {
    handleCurrencyPreferenceCommand(state, currencyPreference, messages);
    saveState(state);
    return { state, messages };
  }
  const notificationChannelIntent = parseNotificationChannelCommand(text);
  if (notificationChannelIntent) {
    await handleNotificationChannelCommand(state, notificationChannelIntent, messages);
    saveState(state);
    return { state, messages };
  }
  const decision = parseDecisionCommand(text);
  if (decision && state.pendingMatches) {
    await handleDecision(state, decision, messages, firstName);
    saveState(state);
    return { state, messages };
  }
  const photoRequestIndex = parsePhotoRequestCommand(text);
  if (photoRequestIndex !== null && state.pendingMatches) {
    await handlePhotoRequest(state, photoRequestIndex, messages);
    saveState(state);
    return { state, messages };
  }

  // One-shot: only the reply immediately after an escrow/inspection suggestion is checked for
  // a "yes" — cleared regardless of what they said, so it never nags on a later, unrelated
  // message, and so this can't misfire against natural-language decision interpretation
  // further down (a bare "yes" with a still-open pendingMatches set would otherwise be
  // ambiguous between "yes, I want the escrow code" and "yes, approve the last one").
  if (state.pendingEscrowOffer) {
    state.pendingEscrowOffer = false;
    if (/^(yes|yeah|yep|yup|sure|ok|okay)\b/i.test(text.trim())) {
      messages.push(
        `Great — use code ${config.fiFlow.escrowPromoCode} for your first escrow/inspection service free, and 50% off future services with a Fi membership.`
      );
      saveState(state);
      return { state, messages };
    }
    // Not an affirmative reply — fall through so this message is still handled normally.
  }

  // One-shot: only the reply immediately after the "listings" menu is checked for 1/2/3.
  // Cleared regardless of what they said, matching the same pattern as pendingEscrowOffer.
  if (state.pendingListingsMenu) {
    state.pendingListingsMenu = false;
    const choice = text.trim();
    if (choice === "1") {
      messages.push(await formatApprovedListingsSummary(state.phone));
      saveState(state);
      return { state, messages };
    }
    if (choice === "2") {
      messages.push(formatPendingListingsSummary(state));
      saveState(state);
      return { state, messages };
    }
    if (choice === "3") {
      messages.push(await formatMyListingsSummary(state.phone));
      saveState(state);
      return { state, messages };
    }
    // Not 1/2/3 — fall through so this message is still handled normally.
  }

  // Fi asked a direct question ("what's the best number to reach you at on SMS?") and this
  // reply is answering exactly that — unlike the other one-shot pending checks above, an
  // unrecognized reply keeps waiting rather than falling through, since there's no sensible
  // "normal handling" for a bare phone number otherwise.
  if (state.pendingChannelLink) {
    const channel = state.pendingChannelLink;
    const digits = text.replace(/[^\d+]/g, "").replace(/^\+/, "");
    if (digits.length >= 7 && digits.length <= 15) {
      state.pendingChannelLink = undefined;
      const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(state.phone), state.phone);
      const linked = await linkIdentity(canonicalUserId, channel, phoneIdentityForChannel(channel, digits));
      messages.push(
        linked.ok
          ? `Linked! I'll send your matches and alerts on ${channelLabel(channel)} from now on.`
          : linked.reason === "already_linked_here"
          ? "That number is already linked to your account."
          : "That number is already linked to a different Fi account, so I can't connect it here."
      );
      saveState(state);
      return { state, messages };
    }
    // Not a phone number — "cancel" is already handled above (before this block is ever
    // reached) and clears pendingChannelLink there, so it never falls through to here.
    messages.push(`That doesn't look like a phone number. What's the best number to reach you at on ${channelLabel(channel)}? Or say "cancel" to stop.`);
    saveState(state);
    return { state, messages };
  }

  if (state.pendingReplacementRequest) {
    const replacement = state.pendingReplacementRequest;
    state.pendingReplacementRequest = undefined;
    if (/\breplace\b/i.test(text)) {
      state.pendingSellIntake = undefined;
      state.pendingBuyIntake = undefined;
      saveState(state);
      return handleIncomingMessage(phone, replacement, contact, imageUrl);
    }
    if (/\badd\b/i.test(text)) {
      messages.push("Okay — I kept your current draft. Finish or cancel it first, then send the additional request again.");
      saveState(state);
      return { state, messages };
    }
    messages.push('Please reply "replace" or "add another".');
    state.pendingReplacementRequest = replacement;
    saveState(state);
    return { state, messages };
  }

  // A fresh WTB can restate and complete an existing WTB draft in one message. Cross-type
  // requests still use the explicit replace/add safeguard below.
  if (state.pendingBuyIntake && isFreshBuyRequest(text)) {
    state.pendingBuyIntake = undefined;
    saveState(state);
    return handleIncomingMessage(phone, text, contact, imageUrl);
  }

  if ((state.pendingSellIntake || state.pendingBuyIntake) && (isFreshSellRequest(text) || isFreshBuyRequest(text))) {
    state.pendingReplacementRequest = text;
    messages.push("You already have an incomplete request. Should I replace it or add another?");
    saveState(state);
    return { state, messages };
  }

  if (state.pendingSellIntake) {
    await handleSellIntakeAnswer(state, text, imageUrl, messages, contact);
    saveState(state);
    return { state, messages };
  }

  if (state.pendingBuyIntake) {
    await handleBuyIntakeAnswer(state, text, messages, contact);
    saveState(state);
    return { state, messages };
  }

  if (state.pendingPreferenceCollection) {
    await handlePreferenceAnswer(state, text, messages);
    saveState(state);
    return { state, messages };
  }

  if (state.pendingNaturalFollowUp) {
    await handleNaturalFollowUpAnswer(state, text, messages);
    saveState(state);
    return { state, messages };
  }

  // Fi Concierge Stage 3: people rarely type the literal "approve <n>"/"pass <n>" format they
  // were shown — "I'll take the first one", "pass on that", "yeah let's do #2" all mean the
  // same thing. Only tried when the deterministic parser above found nothing AND there's
  // actually something pending to decide on, and only for the AI matching test phone — see
  // ai/decisionInterpreter.ts for why this can never approve/reveal/charge anything beyond
  // what handleDecision (the SAME function the deterministic path uses) already allows.
  //
  // Required routing fix, item 4: "a pending match must never block a new natural-language
  // request." A message that itself looks like a fresh buy/sell request (BUY_KEYWORDS/
  // SELL_KEYWORDS) skips decision-interpretation entirely rather than risking an AI
  // misclassification swallowing it as approve/pass — this is exactly the reported failure
  // mode ("pending-decision state intercepting natural-language messages").
  const looksLikeFreshRequest = BUY_KEYWORDS.test(text) || SELL_KEYWORDS.test(text);
  if (state.pendingMatches && isAiMatchingEnabledForPhone(phone) && !GREETING.test(text.trim()) && !looksLikeFreshRequest) {
    const interpretedDecision = await interpretDecision(text, state.pendingMatches.matches.length);
    if (interpretedDecision?.action) {
      // No number identified in the natural phrasing -> same "latest unresolved match" default
      // as the deterministic bare "approve"/"pass" (see handleDecision), not always the first.
      await handleDecision(state, { action: interpretedDecision.action, index: interpretedDecision.index }, messages, firstName);
      saveState(state);
      return { state, messages };
    }
  }

  const resolved = await resolveItemRequests(phone, text);
  const parsed = resolved.items;

  // Onboarding belongs after deterministic commands: help/status/listing management/etc. must
  // always retain their command semantics on a brand-new account. The first ordinary inbound
  // message consumes this one-shot state and may then continue into normal intent handling.
  if (state.stage === "new") {
    messages.push(config.fiFlow.introMessage);
    state.stage = "active";
    if (parsed.length === 0) {
      saveState(state);
      return { state, messages };
    }
  }

  if (parsed.length === 0) {
    if (decision) {
      messages.push("I don't have any open matches to decide on right now — search for an item first.");
    } else {
      // Genuine small talk / a question / a greeting — nothing else about this message matched
      // anything (already ruled out as a decision above, if matches were pending). AI here only
      // ever supplies the reply TEXT (see ai/chatReply.ts); it cannot search, approve, or touch
      // any state, so the canned fallback is a fully safe default whenever AI is off/unavailable
      // General chat is enabled for all contacts once the operator explicitly enables AI and
      // configures credentials; matching and decisions keep their stricter phone allowlist.
      //
      // Real reported bug: state.pendingMatches stays set even after every entry in it has
      // already been approved/passed (it's only ever replaced by a new search, see startSearch),
      // so checking for its mere existence kept showing the "approve/pass" reminder forever —
      // e.g. saying "hi" well after the only match shown was already approved. The reminder now
      // only fires while something in the set is still actually undecided.
      const unresolvedCount = state.pendingMatches?.decisions.filter((d) => d === "pending").length ?? 0;
      const canned =
        unresolvedCount > 0
          ? 'Reply "approve <number>" or "pass <number>" for one of the matches above, or tell me a new item to search.'
          : GREETING.test(text.trim())
            ? `Hi ${firstName}, how can I help you today?`
            : 'Try "buy: Rolex Daytona" or "selling: Hermes Birkin".';
      const aiReply = isAiChatEnabled() ? await generateGeneralChatReply(text, unresolvedCount) : null;
      messages.push(aiReply ?? canned);
    }
    saveState(state);
    return { state, messages };
  }

  // Only one item searched at a time — a new search replaces whatever was still pending.
  // Unlike approvals, searching itself is unlimited, so there's no queue to manage.
  if (parsed.length > 1) {
    messages.push(`I'll start with the first one — send me the others one at a time whenever you're ready.`);
  }

  // The documented `buy:` / `sell:` command remains a one-off inventory search for backward
  // compatibility. Conversational WTB/FS language creates a monitored posting and therefore
  // uses the confirmation-gated intake below. Keeping these two explicit surfaces distinct
  // avoids turning an existing search command into a draft that intercepts approve/pass.
  if (/^\s*(?:buy|sell)\s*:/i.test(text)) {
    if (!state.preferencesCollected) {
      state.pendingPreferenceCollection = { step: "price", request: parsed[0] };
      messages.push("Before I search, a few quick preferences — just this once:\n\n" + PRICE_QUESTION);
      saveState(state);
      return { state, messages };
    }
    await startSearch(state, parsed[0], messages);
    saveState(state);
    return { state, messages };
  }

  // AI-matching test accounts retain the pre-existing ephemeral-search path. This is an
  // operator-only compatibility surface used to evaluate reranking/decision behavior; normal
  // WhatsApp/SMS WTB and FS requests continue into the confirmation-gated posting intake.
  const aiSearchPreferences = resolved.aiPreferences ?? (await tryNaturalLanguagePreferences(phone, text));
  if (aiSearchPreferences) {
    const missing = missingPreferenceFields(aiSearchPreferences);
    if (missing.length > 0) {
      state.pendingNaturalFollowUp = { request: parsed[0], partial: aiSearchPreferences, missing };
      messages.push(missingFieldsQuestion(missing));
      saveState(state);
      return { state, messages };
    }
    state.preferences = aiSearchPreferences;
    state.preferencesCollected = true;
    await startSearch(state, parsed[0], messages);
    saveState(state);
    return { state, messages };
  }

  // FS/WTB messages are postings, not generic searches. Complete and save the posting first;
  // only the completion handler is allowed to run matching. This also keeps seller fields out
  // of the buyer-preference interview entirely.
  if (parsed[0].action === "sell") {
    await startSellIntake(state, parsed[0], messages, text, imageUrl);
    saveState(state);
    return { state, messages };
  }
  await startBuyIntake(state, parsed[0], messages, text);
  saveState(state);
  return { state, messages };
}
