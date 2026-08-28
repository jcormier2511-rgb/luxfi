import { config, isAiMatchingEnabledForPhone } from "../config";
import { Contact, ConversationState, ItemRequest, InventoryListing, SearchPreferences, MatchDecision } from "../types";
import { findMatchesHybrid, formatMatchCard, formatMatchApproved, attachPriceSignals } from "../matching/engine";
import { PriceSignal } from "../matching/priceSignal";
import { requestPhotosForMatch } from "../matching/photoRequests";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";
import { getState, saveState } from "./stateStore";
import { parsePriceRange, parseFreeformPreference } from "./preferences";
import { getEntitlement, recordBillingRequested } from "../billing/entitlementStore";
import { interpretQuery, toSearchPreferences } from "../ai/queryInterpreter";
import { interpretDecision } from "../ai/decisionInterpreter";
import { generateGeneralChatReply } from "../ai/chatReply";
import { extractIntent, isConfidentIntent } from "../ai/intentExtractor";

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
    .split(/\n|,|;|\band\b/i)
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

function parseDecisionCommand(text: string): DecisionCommand | null {
  const m = text.trim().match(/^(approve|pass)\b\s*#?(\d+)?/i);
  if (!m) return null;
  return { action: m[1].toLowerCase() as "approve" | "pass", index: m[2] ? parseInt(m[2], 10) : null };
}

/** Matches "photos <n>", "photo <n>", and "request photos <n>" (spec's three accepted forms). */
function parsePhotoRequestCommand(text: string): number | null {
  const m = text.trim().match(/^(?:request\s+)?photos?\b\s*#?(\d+)?/i);
  if (!m) return null;
  return m[1] ? parseInt(m[1], 10) : 1;
}

const MENU_COMMAND = /^(help|menu)\b/i;
const CANCEL_COMMAND = /^cancel\b/i;
const STATUS_COMMAND = /^status\b/i;
// A bare greeting (spec: "'hi' should return the Fi menu, not force approve/pass") is NOT its
// own deterministic command here — a brand-new contact's first "hi" must still get the normal
// intro message (see state.stage === "new" below), and an existing contact's "hi" with matches
// pending must still get the ordinary general-chat reply, not a menu dump. The one concrete risk
// a greeting actually posed was being swallowed by AI decision-interpretation (interpretDecision,
// below) — this is checked there directly, so a greeting always falls through to the normal
// intro/general-chat path instead.
const GREETING = /^(hi|hello|hey|hiya|yo|good\s+(morning|afternoon|evening))\b/i;

const FI_MENU = [
  "Hi, I'm Fi — here's what I can do:",
  '"buy: <item>" or "sell: <item>" — search for a match (plain English works too, e.g. "looking for a black Daytona under 25k")',
  '"approve <number>" — connect with a match',
  '"photos <number>" — privately ask the seller for photos',
  '"pass <number>" — skip a match',
  '"cancel" — clear your current matches',
  '"status" — check your account status',
  '"help" — show this menu',
].join("\n");

/** "status" — a quick, honest snapshot of trial usage and anything still awaiting a decision. */
async function handleStatusCommand(state: ConversationState, messages: string[]): Promise<void> {
  const pendingCount = state.pendingMatches?.decisions.filter((d) => d === "pending").length ?? 0;
  const entitlement = await getEntitlement(state.phone);
  const approvalLine = entitlement.manualOverrideEnabled
    ? `Approved matches: ${state.approvedCount} (unlimited — your account is unlocked)`
    : `Approved matches: ${state.approvedCount}/${config.trial.maxApprovedMatches}`;
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
  const hadSomethingToCancel = Boolean(state.pendingMatches || state.pendingPreferenceCollection || state.pendingNaturalFollowUp);
  state.pendingMatches = undefined;
  state.pendingPreferenceCollection = undefined;
  state.pendingNaturalFollowUp = undefined;
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
    const wtbFeedNote =
      request.action === "sell" && !config.watchfacts.enableWtbSync
        ? " (the external WTB feed is currently disabled, so I'm relying on monitored group chats for buyer matches)"
        : "";
    messages.push(`No live matches yet for "${request.query}"${wtbFeedNote} — I'll keep watching the network.`);
    console.log(`[router] new_search=true pending_match_preserved=${hadExistingPending}`);
    return;
  }

  // Comps-based price signal (Attractive/Fair/High vs. other active listings for the same
  // reference) — see matching/priceSignal.ts. FS results only; a no-op fetch when there's
  // nothing to signal.
  const signaled = await attachPriceSignals(results);

  // Confirms each listing's detailUrl actually resolves before it's ever sent in a card —
  // a constructed WatchFacts URL isn't guaranteed to be a valid live page (wrong id, expired
  // listing, site-side error). An unreachable URL is dropped rather than sent broken; matching
  // itself (and the listing's own contactPhone) is completely unaffected either way.
  const validated: { listing: InventoryListing; explanation?: string; priceSignal?: PriceSignal }[] = await Promise.all(
    signaled.map(async ({ listing, explanation, priceSignal }) => ({
      listing: { ...listing, detailUrl: await getValidatedListingUrl(listing.detailUrl) },
      explanation,
      priceSignal,
    }))
  );

  // Each card now ends with its own reply instructions (approve/photos/pass for an FS/seller
  // card, approve/pass for a WTB/buyer card) — see formatMatchCard — so there's no separate
  // shared footer message here anymore.
  validated.forEach(({ listing, explanation, priceSignal }, i) =>
    messages.push(formatMatchCard(listing, i, request.action, explanation, priceSignal))
  );
  // A fresh search intentionally starts its own new monitor/numbering (spec: "a new buy/sell
  // request starts a new monitor") — any prior pendingMatches is superseded here, but note that
  // is only reached once THIS search actually has results; an empty one never reaches this line
  // (see above), so an old undecided set is never destroyed by a search that found nothing.
  state.pendingMatches = { request, matches: validated.map((r) => r.listing), decisions: validated.map(() => "pending") };
  console.log(`[router] new_search=true pending_match_preserved=${hadExistingPending}`);
}

/**
 * Handles an "approve <n>" / "pass <n>" reply against the currently pending match set.
 *
 * Fi Build Spec v4 §11: after the 3rd complimentary approval, further approvals are locked
 * until Fi billing is authorized. No payment processor exists yet, so the entitlement check
 * is against `account_entitlements.manual_override_enabled` (Postgres) — the ONLY way to
 * unlock further approvals is an admin action (POST /admin/entitlement/override), never a
 * self-service command and never a live charge. Passing/monitoring stay unrestricted either way.
 */
/** The highest-indexed still-"pending" entry — spec: "approve/pass without a number applies to
 *  the latest unresolved match." Null when every entry has already been decided. */
function findLatestPendingIndex(pending: { decisions: MatchDecision[] }): number | null {
  for (let i = pending.decisions.length - 1; i >= 0; i--) {
    if (pending.decisions[i] === "pending") return i;
  }
  return null;
}

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

  // Approving is the only thing metered against the trial.
  if (state.approvedCount >= config.trial.maxApprovedMatches) {
    const entitlement = await getEntitlement(state.phone);
    if (!entitlement.manualOverrideEnabled) {
      messages.push(config.fiFlow.declineMessage);
      return;
    }
  }

  pending.decisions[idx] = "approved";
  state.approvedCount += 1;
  messages.push(formatMatchApproved(pending.matches[idx], idx));

  if (state.approvedCount === config.trial.maxApprovedMatches) {
    messages.push(config.fiFlow.conversionPitch(firstName));
  }
}

/**
 * "photos <n>" / "photo <n>" / "request photos <n>" — private side traffic on a pending FS/
 * seller match, never a decision: doesn't touch state.approvedCount (nothing here is metered
 * against the trial) and never closes or passes the match — the buyer can still approve or
 * pass at any time, before or after photos arrive. See matching/photoRequests.ts.
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
  const interpreted = await interpretQuery(text);
  const merged = interpreted ? mergeFollowUpPreferences(pending.partial, toSearchPreferences(interpreted)) : pending.partial;

  state.preferences = merged;
  state.preferencesCollected = true;
  const request = pending.request;
  state.pendingNaturalFollowUp = undefined;
  await startSearch(state, request, messages);
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

export async function handleIncomingMessage(phone: string, text: string, contact?: Contact): Promise<FlowResult> {
  const state = getState(phone);
  const messages: string[] = [];
  const firstName = contact?.name?.trim().split(/\s+/)[0] || "there";

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
      // — and it's the ONLY thing every non-test-phone contact ever sees, unchanged.
      const canned = state.pendingMatches
        ? 'Reply "approve <number>" or "pass <number>" for one of the matches above, or tell me a new item to search.'
        : 'Try "buy: Rolex Daytona" or "selling: Hermes Birkin".';
      const aiReply = isAiMatchingEnabledForPhone(phone)
        ? await generateGeneralChatReply(text, state.pendingMatches?.matches.length ?? 0)
        : null;
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

  if (!state.preferencesCollected) {
    // Came straight from the intent extractor's own single AI call above — no separate
    // interpretQuery call needed (that path is the fallback for when AI classification of the
    // MESSAGE ITSELF didn't happen, e.g. AI is off for this phone or classification failed).
    const naturalLanguagePrefs = resolved.aiPreferences ?? (await tryNaturalLanguagePreferences(phone, text));
    if (naturalLanguagePrefs) {
      // A request must always carry budget/location/dial color/condition — ask for exactly
      // what this one message didn't already cover, once, rather than proceeding with gaps.
      const missing = missingPreferenceFields(naturalLanguagePrefs);
      if (missing.length > 0) {
        state.pendingNaturalFollowUp = { request: parsed[0], partial: naturalLanguagePrefs, missing };
        messages.push(missingFieldsQuestion(missing));
        saveState(state);
        return { state, messages };
      }
      state.preferences = naturalLanguagePrefs;
      state.preferencesCollected = true;
    } else {
      state.pendingPreferenceCollection = { step: "price", request: parsed[0] };
      messages.push("Before I search, a few quick preferences — just this once:\n\n" + PRICE_QUESTION);
      saveState(state);
      return { state, messages };
    }
  }

  if (resolved.priceUnreliable) {
    messages.push("Price: Not reliably parsed — searching without a budget filter for this one.");
  }

  await startSearch(state, parsed[0], messages);

  saveState(state);
  return { state, messages };
}
