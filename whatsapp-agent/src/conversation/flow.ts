import { config, isAiMatchingEnabledForPhone } from "../config";
import { Contact, ConversationState, ItemRequest, InventoryListing, SearchPreferences } from "../types";
import { findMatchesHybrid, formatMatchCard, formatMatchApproved } from "../matching/engine";
import { getValidatedListingUrl } from "../watchfacts/urlValidator";
import { getState, saveState } from "./stateStore";
import { parsePriceRange, parseFreeformPreference } from "./preferences";
import { getEntitlement, recordBillingRequested } from "../billing/entitlementStore";
import { interpretQuery, toSearchPreferences } from "../ai/queryInterpreter";

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

  const decision = parseDecisionCommand(text);
  if (decision && state.pendingMatches) {
    await handleDecision(state, decision, messages, firstName);
    saveState(state);
    return { state, messages };
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
    } else if (state.pendingMatches) {
      messages.push('Reply "approve <number>" or "pass <number>" for one of the matches above, or tell me a new item to search.');
    } else {
      messages.push('Try "buy: Rolex Daytona" or "selling: Hermes Birkin".');
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
