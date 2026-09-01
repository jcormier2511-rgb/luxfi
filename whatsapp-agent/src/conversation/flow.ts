import { config, isAiChatEnabled, isAiMatchingEnabledForPhone } from "../config";
import { Contact, ConversationState, ItemRequest, InventoryListing, SearchPreferences, MatchDecision, PendingSellIntake, PendingBuyIntake } from "../types";
import { findMatchesHybrid, formatMatchCard, formatMatchApproved, attachPriceSignals, attachCurrencyDisplay, CurrencyDisplay } from "../matching/engine";
import { PriceSignal } from "../matching/priceSignal";
import { requestPhotosForMatch } from "../matching/photoRequests";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";
import { getState, saveState } from "./stateStore";
import { parsePriceRange, parseFreeformPreference } from "./preferences";
import { recordBillingRequested } from "../billing/entitlementStore";
import { MEMBERSHIP_PLANS } from "../billing/plans";
import { getApprovalUsage, evaluateApprovalGate, recordApprovalEventForPhone, getApprovedMatchesSummary } from "../postings/approvalUsage";
import { getOrCreateCanonicalUser } from "../postings/identity";
import { platformForIdentity } from "../channels/identity";
import { getActivePostingsForUser } from "../postings/postingsStore";
import { interpretQuery, toSearchPreferences } from "../ai/queryInterpreter";
import { interpretDecision } from "../ai/decisionInterpreter";
import { generateGeneralChatReply } from "../ai/chatReply";
import { detectCurrency } from "../matching/currency";

import { extractIntent, isConfidentIntent } from "../ai/intentExtractor";
import { CURRENCY_CODES } from "../fx/currency";
import { extractReference, containsKnownBrand, normalizePriceShorthand, normalizeText } from "../postings/normalize";
import { upsertListings } from "../watchfacts/inventoryDb";
import { ingestDirectSellPosting, ingestDirectBuyPosting } from "../postings/ingest";

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
  return OPT_OUT_WORDS.some((w) => n === w || n.startsWith(`${w} `));
}

const BUY_KEYWORDS = /\b(buy|buying|wtb|looking for|want|need|iso|find me|in search of)\b/i;
const SELL_KEYWORDS = /\b(sell|selling|fs|for sale|i have|wts)\b/i;

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
  "want to",
  "i need to",
  "need to",
  "i need",
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

export function parseItemRequests(text: string): ItemRequest[] {
  const segments = text
    // A comma inside a formatted number is data, not an item separator. Splitting
    // "$110,000" here used to turn the request into "...under $110" plus "000".
    .split(/\n|,(?!\d)|;|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const items: ItemRequest[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const parsed = classify(seg);
    if (!parsed) continue;
    const key = `${parsed.action}:${parsed.query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(parsed);
  }
  return items;
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

// "start" is folded in here too (for anyone not currently opted-out — see isOptOut/the
// opted_out branch above, checked first and separately) — a real reported gap: someone who
// got lost mid-conversation naturally reached for "start" expecting it to reorient them, and
// got the generic "reply approve/pass..." reminder instead.
const MENU_COMMAND = /^(help|menu|start)\b/i;
const CANCEL_COMMAND = /^cancel\b/i;
const STATUS_COMMAND = /^status\b/i;
// Broadened past the exact word "listings" for the same reason — "listing summary", "my
// listing", and "summary" are all natural ways to ask for the same thing.
const LISTINGS_COMMAND = /^(my\s+)?(listings?(\s+summary)?|summary)\b/i;

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
  if (postings.length === 0) return "You don't have any active WTB or FS listings being monitored right now.";
  const lines = postings.map((p, i) => {
    const label = p.reference ? `${p.brand || ""} ${p.reference}`.trim() : p.original_text.slice(0, 80);
    const priceLine = p.price ? ` — $${p.price}` : "";
    return `${i + 1}. [${p.type}] ${label}${priceLine}`;
  });
  return "Your active listings:\n\n" + lines.join("\n");
}

/** "status" — a quick, honest snapshot of trial/plan usage and anything still awaiting a
 *  decision. Reads live from the same canonical Postgres counter both the on-demand (v3) and
 *  automatic-matching (v4) approve paths share (see postings/approvalUsage.ts) — never a
 *  locally-cached count that could drift from what actually gated the last approval. */
async function handleStatusCommand(state: ConversationState, messages: string[]): Promise<void> {
  const pendingCount = state.pendingMatches?.decisions.filter((d) => d === "pending").length ?? 0;
  const usage = await getApprovalUsage(state.phone);
  let approvalLine: string;
  if (usage.isComplimentary) {
    approvalLine = `Approved matches: ${usage.totalApproved}/${config.trial.maxApprovedMatches} (complimentary trial)`;
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
  messages.push([approvalLine, pendingLine].join("\n"));
}

/** "cancel" — clears the current pending match set (and any in-progress preference interview)
 *  without unsubscribing. A deliberate, explicit user action, distinct from a new search
 *  superseding an old one — see the "never delete a pending match merely because another search
 *  starts" rule this does NOT apply to. */
function handleCancelCommand(state: ConversationState, messages: string[]): void {
  const hadSomethingToCancel = Boolean(
    state.pendingMatches || state.pendingPreferenceCollection || state.pendingNaturalFollowUp || state.pendingSellIntake || state.pendingBuyIntake
  );
  state.pendingMatches = undefined;
  state.pendingPreferenceCollection = undefined;
  state.pendingNaturalFollowUp = undefined;
  state.pendingSellIntake = undefined;
  state.pendingBuyIntake = undefined;
  state.pendingReplacementRequest = undefined;
  state.pendingEscrowOffer = false;
  state.pendingListingsMenu = false;
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

/** Runs a fresh search for `request`, showing Match Cards and arming them for approve/pass. */
async function startSearch(state: ConversationState, request: ItemRequest, messages: string[]): Promise<void> {
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

/** Private listing shorthand commonly omits a currency marker. Only accept a standalone
 * trailing amount, and never the already-identified reference, so 116500LN cannot become a
 * price while `... 28500` reliably does. */
function extractListingAmount(text: string, reference: string | null): number | undefined {
  const marked = text.match(/(?:under|max(?:imum)?|budget|asking|price|for|[$€£])(?:\s+is)?\s*[$€£]?\s*([\d,.]+\s*k?)/i);
  const trailing = text.match(/(?:^|\s)([\d,.]+\s*k?)\s*$/i);
  const raw = marked?.[1] ?? trailing?.[1];
  if (!raw || raw.toUpperCase() === reference?.toUpperCase()) return undefined;
  return normalizePriceShorthand(raw) ?? undefined;
}

function intakeSlots(text: string, reference: string | null) {
  const price = extractListingAmount(text, reference);
  const location =
    text.match(/\b(?:in|from|located in|based in)\s+(?:the\s+)?(US|USA|United States|UK|UAE|Hong Kong|Singapore|Canada|Europe)\b/i)?.[1] ??
    text.match(/^\s*(US|USA|United States|UK|UAE|Hong Kong|Singapore|Canada|Europe)\s*$/i)?.[1];
  const condition = text.match(/\b(pre[- ]?owned|used|unworn|brand new|new|mint|any condition)\b/i)?.[1];
  const dial = text.match(/^\s*(black|white|blue|green|silver|champagne|either|any)\s*(?:dial|color)?\s*$/i)?.[1] ?? text.match(/\b(black|white|blue|green|silver|champagne|either|any)\s*(?:dial|color)\b/i)?.[1];
  const normalized=normalizeText(text); const words=stripLeadingIntent(text).replace(extractReference(text)??"","").trim().split(/\s+/);
  const brand=normalized.brand||undefined; const model=brand ? words.filter(w=>!brand.toLowerCase().split(/\s+/).includes(w.toLowerCase()))[0] : undefined;
  const boxPapers=/\b(full set|box(?: and | & |\/)?papers?|papers)\b/i.exec(text)?.[1]; const year=/\b(19\d{2}|20\d{2})\b/.exec(text)?.[1];
  return { reference: extractReference(text), price, currency: price === undefined ? undefined : detectCurrency(text) ?? "USD", location, condition, dial,brand,model,boxPapers,year };
}

function dialRelevant(reference: string | null): boolean { return /^(116500LN|126500LN)$/i.test(reference ?? ""); }

function applySellSlots(p: PendingSellIntake, text: string): boolean {
  const s = intakeSlots(text, p.reference); let changed = false;
  if (s.reference) { p.reference = s.reference; changed = true; }
  if(s.brand){p.brand=s.brand;changed=true;} if(s.model){p.model=s.model;changed=true;} if(s.boxPapers){p.boxPapers=s.boxPapers;changed=true;} if(s.year){p.year=s.year;changed=true;}
  if (containsKnownBrand(text) || s.reference) { p.description = stripLeadingIntent(text); changed = true; }
  if (s.price !== undefined) { p.price = s.price; p.currency = s.currency; changed = true; }
  if (s.location) { p.location = s.location; changed = true; }
  if (s.condition) { p.condition = s.condition; changed = true; }
  if (s.dial) { p.dialColor = s.dial; changed = true; }
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
  if (s.dial) { p.dialColor = s.dial; changed = true; }
  return changed;
}
function nextSell(p: PendingSellIntake): string | null {
  if (!p.brand) { p.step="details"; return SELL_DETAILS_QUESTION; }
  if (!p.reference) { p.step="details"; return "Do you have the reference number?"; }
  if (p.price === undefined) { p.step="price"; return SELL_PRICE_QUESTION; }
  if (dialRelevant(p.reference) && !p.dialColor) { p.step="dial"; return "Is it the black dial, white dial, or another color?"; }
  if (!p.condition) { p.step="condition"; return CONDITION_INTAKE_QUESTION; }
  if (!p.location) { p.step="location"; return SELL_LOCATION_QUESTION; }
  if (!p.imageUrl && !p.photoSkipped) { p.step="photo"; return SELL_PHOTO_QUESTION; }
  p.step="confirm"; return null;
}
function nextBuy(p: PendingBuyIntake): string | null {
  if (!p.brand) { p.step="details"; return "What would you like to buy? Please include the brand and model."; }
  if (!p.reference) { p.step="details"; return "Do you have the reference number?"; }
  if (p.budget === undefined) { p.step="budget"; return BUY_BUDGET_QUESTION; }
  if (dialRelevant(p.reference) && !p.dialColor) { p.step="dial"; return DIAL_INTAKE_QUESTION; }
  if (!p.condition) { p.step="condition"; return BUY_CONDITION_QUESTION; }
  if (!p.location) { p.step="location"; return BUY_LOCATION_QUESTION; }
  p.step="confirm"; return null;
}
const confirmed = (text: string) => /^(yes|yep|yeah|confirm|correct|sure|ok(?:ay)?|start|do it)\b/i.test(text.trim());
const cash = (n: number, c = "USD") => `${c === "USD" ? "$" : c+" "}${n.toLocaleString("en-US")}`;
const review=(type:string,p:PendingSellIntake|PendingBuyIntake,price:number)=>[`${type} listing review`,`Brand: ${p.brand||"Not provided"}`,`Model: ${p.model||"Not provided"}`,`Reference: ${p.reference||"Not provided"}`,p.dialColor&&`Dial: ${p.dialColor}`,p.condition&&`Condition: ${p.condition}`,`Price: ${cash(price,p.currency)}`,p.location&&`Location: ${p.location}`,p.boxPapers&&`Box/Papers: ${p.boxPapers}`,p.year&&`Year: ${p.year}`,`Images: ${"imageUrl" in p&&p.imageUrl?"attached":"none"}`,"Reply confirm to activate, or send a correction."].filter(Boolean).join("\n");
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
  const p: PendingSellIntake = { step:"details", description:request.query, reference:extractReference(request.query), condition:suppliedCondition, location:suppliedLocation, imageUrl };
  applySellSlots(p, originalText); state.pendingSellIntake=p; messages.push(nextSell(p) ?? sellSummary(p));
}

async function startBuyIntake(state: ConversationState, request: ItemRequest, messages: string[], originalText: string, suppliedCondition?: string, suppliedLocation?: string): Promise<void> {
  const p: PendingBuyIntake = { step:"details", description:request.query, reference:extractReference(request.query), condition:suppliedCondition, location:suppliedLocation };
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
  if(p.step==="confirm" && confirmed(text)){ await persistSellIntake(state,p); const {matchesFound}=await ingestDirectSellPosting({phone:state.phone,senderName:contact?.name,description:p.description,brand:p.brand,model:p.model,reference:p.reference,price:p.price!,currency:p.currency,dialColor:p.dialColor,condition:p.condition,location:p.location,boxPapers:p.boxPapers,year:p.year,notes:p.notes,imageUrl:p.imageUrl}); messages.push(matchesFound?`Your listing is active. I found ${matchesFound} potential buyer${matchesFound===1?"":"s"}.`:"Your listing is active. I'll keep monitoring for a qualifying buyer."); state.pendingSellIntake=undefined; return; }
  const skippedPhoto = p.step === "photo" && /^(?:skip|no\s+photo|none)$/i.test(text.trim());
  if (skippedPhoto) p.photoSkipped = true;
  if (/\?/.test(text)) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I can help with that while keeping your listing draft open."); messages.push(nextSell(p)??sellSummary(p)); return; }
  const freeLocation=p.step==="location"&&!intakeSlots(text,p.reference).location&&Boolean(text.trim()); if(freeLocation)p.location=text.trim();
  const changed=applySellSlots(p,text) || suppliedPhoto || skippedPhoto || freeLocation;
  if(!changed && /^any$/i.test(text.trim())) { if(p.step==="dial")p.dialColor="either"; else if(p.step==="condition")p.condition="any"; else if(p.step==="location")p.location="any"; }
  else if(!changed) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I kept your listing draft open."); }
  messages.push(nextSell(p)??sellSummary(p));
}

async function handleBuyIntakeAnswer(state: ConversationState, text: string, messages: string[], contact?: Contact): Promise<void> {
  const p=state.pendingBuyIntake!;
  if(p.step==="confirm" && confirmed(text)){ const {matchesFound}=await ingestDirectBuyPosting({phone:state.phone,senderName:contact?.name,description:p.description,brand:p.brand,model:p.model,reference:p.reference,price:p.budget!,currency:p.currency,dialColor:p.dialColor,condition:p.condition,location:p.location,boxPapers:p.boxPapers,year:p.year,notes:p.notes}); messages.push(matchesFound?`Your request is active. I found ${matchesFound} potential listing${matchesFound===1?"":"s"}.`:"Your request is active. I'll keep monitoring for matching inventory."); state.pendingBuyIntake=undefined; return; }
  if (/\?/.test(text)) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I can help with that while keeping your request draft open."); messages.push(nextBuy(p)??buySummary(p)); return; }
  const freeLocation=p.step==="location"&&!intakeSlots(text,p.reference).location&&Boolean(text.trim()); if(freeLocation)p.location=text.trim();
  const changed=applyBuySlots(p,text)||freeLocation;
  if(!changed && /^any$/i.test(text.trim())) { if(p.step==="dial")p.dialColor="either"; else if(p.step==="condition")p.condition="any"; else if(p.step==="location")p.location="any"; }
  else if(!changed) { const reply=isAiChatEnabled()?await generateGeneralChatReply(text,0):null; messages.push(reply??"I kept your request draft open."); }
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

  // START is a universal conversational reset, not only an opt-out recovery command. A user
  // with old pending matches must be able to begin again instead of being trapped behind the
  // approve/pass reminder shown in the reported live conversation.
  if (normalize(text) === "start") {
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
      messages: ["Hi, I'm Fi — here's what I can do: tell me naturally what you're looking to buy or sell, or ask me anything about your listings."],
    };
  }

  if (isOptOut(text)) {
    state.stage = "opted_out";
    saveState(state);
    return { state, messages: ["You're unsubscribed — you won't hear from Fi again. Reply START anytime to opt back in."] };
  }

  if (state.stage === "opted_out") {
    if (normalize(text) === "start") {
      state.stage = "new";
    } else {
      return { state, messages: [] };
    }
  }

  if (/^join$/i.test(text.trim())) {
    // Not a self-service unlock — there's no live payment processor to authorize against.
    // Records intent for an admin to review; only POST /admin/entitlement/override actually
    // enables further approvals (see handleDecision).
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
  if (MENU_COMMAND.test(text.trim())) {
    messages.push(FI_MENU);
    saveState(state);
    return { state, messages };
  }
  if (CANCEL_COMMAND.test(text.trim())) {
    handleCancelCommand(state, messages);
    saveState(state);
    return { state, messages };
  }
  if (STATUS_COMMAND.test(text.trim())) {
    await handleStatusCommand(state, messages);
    saveState(state);
    return { state, messages };
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

  if ((state.pendingSellIntake || state.pendingBuyIntake) && /^\s*(?:FS|WTB|for sale|sell|buy|want to buy)\b/i.test(text)) {
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
