import { config, isAiMatchingEnabledForPhone } from "../config";
import { Contact, ConversationState, ItemRequest, InventoryListing, SearchPreferences } from "../types";
import { findMatchesHybrid, formatMatchCard, formatMatchApproved } from "../matching/engine";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";
import { getState, saveState } from "./stateStore";
import { parsePriceRange, parseFreeformPreference } from "./preferences";
import { getEntitlement, recordBillingRequested } from "../billing/entitlementStore";
import { interpretQuery, toSearchPreferences } from "../ai/queryInterpreter";
import { interpretDecision } from "../ai/decisionInterpreter";
import { generateGeneralChatReply } from "../ai/chatReply";

const OPT_OUT_WORDS = ["stop", "unsubscribe", "cancel", "opt out", "optout"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isOptOut(text: string): boolean {
  const n = normalize(text);
  return OPT_OUT_WORDS.some((w) => n === w || n.startsWith(`${w} `));
}

const BUY_KEYWORDS = /\b(buy|buying|wtb|looking for|want|need)\b/i;
const SELL_KEYWORDS = /\b(sell|selling|fs|for sale)\b/i;

function classify(segment: string): ItemRequest | null {
  const text = segment.trim();
  if (!text) return null;
  // Require an explicit buy/sell signal — otherwise plain chatter ("hi", "ok", "thanks")
  // would get misread as an item request.
  let action: ItemRequest["action"];
  if (SELL_KEYWORDS.test(text)) action = "sell";
  else if (BUY_KEYWORDS.test(text)) action = "buy";
  else return null;
  const query = text
    .replace(/^(buy|buying|wtb|looking for|want|need|sell|selling|fs|for sale)\s*:?\s*/i, "")
    .trim();
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
  index: number; // 1-based
}

function parseDecisionCommand(text: string): DecisionCommand | null {
  const m = text.trim().match(/^(approve|pass)\b\s*#?(\d+)?/i);
  if (!m) return null;
  return { action: m[1].toLowerCase() as "approve" | "pass", index: m[2] ? parseInt(m[2], 10) : 1 };
}

export interface FlowResult {
  state: ConversationState;
  messages: string[];
}

/** Runs a fresh search for `request`, showing Match Cards and arming them for approve/pass. */
async function startSearch(state: ConversationState, request: ItemRequest, messages: string[]): Promise<void> {
  // findMatchesHybrid only ever activates AI-assisted matching for the configured test phone
  // (see config.isAiMatchingEnabledForPhone) — every other contact gets exactly the plain
  // deterministic engine, unchanged.
  const results = await findMatchesHybrid(state.phone, request, config.trial.maxOptionsPerItem, state.preferences);
  if (results.length === 0) {
    messages.push(`No live matches yet for "${request.query}" — I'll keep watching the network.`);
    state.pendingMatches = undefined;
    return;
  }

  // Confirms each listing's detailUrl actually resolves before it's ever sent in a card —
  // a constructed WatchFacts URL isn't guaranteed to be a valid live page (wrong id, expired
  // listing, site-side error). An unreachable URL is dropped rather than sent broken; matching
  // itself (and the listing's own contactPhone) is completely unaffected either way.
  const validated: { listing: InventoryListing; explanation?: string }[] = await Promise.all(
    results.map(async ({ listing, explanation }) => ({
      listing: { ...listing, detailUrl: await getValidatedListingUrl(listing.detailUrl) },
      explanation,
    }))
  );

  validated.forEach(({ listing, explanation }, i) => messages.push(formatMatchCard(listing, i, request.action, explanation)));
  messages.push('Reply "approve <number>" to connect, or "pass <number>" to skip one.');
  state.pendingMatches = { request, matches: validated.map((r) => r.listing), decisions: validated.map(() => "pending") };
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
async function handleDecision(state: ConversationState, decision: DecisionCommand, messages: string[], firstName: string): Promise<void> {
  const pending = state.pendingMatches!;
  const idx = decision.index - 1;
  const current = pending.decisions[idx];

  if (idx < 0 || idx >= pending.matches.length) {
    messages.push(`I don't have a match #${decision.index} — pick a number from the list above.`);
    return;
  }
  if (current !== "pending") {
    messages.push(`You already ${current} match #${decision.index}.`);
    return;
  }

  if (decision.action === "pass") {
    pending.decisions[idx] = "passed";
    messages.push(`Passing on #${decision.index}.`);
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

  const decision = parseDecisionCommand(text);
  if (decision && state.pendingMatches) {
    await handleDecision(state, decision, messages, firstName);
    saveState(state);
    return { state, messages };
  }

  // Fi Concierge Stage 3: people rarely type the literal "approve <n>"/"pass <n>" format they
  // were shown — "I'll take the first one", "pass on that", "yeah let's do #2" all mean the
  // same thing. Only tried when the deterministic parser above found nothing AND there's
  // actually something pending to decide on, and only for the AI matching test phone — see
  // ai/decisionInterpreter.ts for why this can never approve/reveal/charge anything beyond
  // what handleDecision (the SAME function the deterministic path uses) already allows.
  if (state.pendingMatches && isAiMatchingEnabledForPhone(phone)) {
    const interpretedDecision = await interpretDecision(text, state.pendingMatches.matches.length);
    if (interpretedDecision?.action) {
      await handleDecision(
        state,
        { action: interpretedDecision.action, index: interpretedDecision.index ?? 1 },
        messages,
        firstName
      );
      saveState(state);
      return { state, messages };
    }
  }

  const parsed = parseItemRequests(text);

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
    const naturalLanguagePrefs = await tryNaturalLanguagePreferences(phone, text);
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

  await startSearch(state, parsed[0], messages);

  saveState(state);
  return { state, messages };
}
