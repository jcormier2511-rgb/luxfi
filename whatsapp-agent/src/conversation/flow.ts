import { config } from "../config";
import { Contact, ConversationState, ItemRequest } from "../types";
import { findMatches, formatMatchAnonymous, formatMatchRevealed } from "../matching/engine";
import { suggestListings } from "../data/inventoryStore";
import { getState, saveState } from "./stateStore";

const OPT_OUT_WORDS = ["stop", "unsubscribe", "cancel", "opt out", "optout"];
const AFFIRMATIVE = /^(y|yes|yeah|yep|yup|sure|please|ok|okay|send it|send them|send)\b/i;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isOptOut(text: string): boolean {
  const n = normalize(text);
  return OPT_OUT_WORDS.some((w) => n === w || n.startsWith(`${w} `));
}

function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(text.trim());
}

function trialEndedMessage(): string {
  const demo = config.outreach.demoUrl ? ` or schedule a demo here: ${config.outreach.demoUrl}` : "";
  return `Reached my free quota — you're welcome to start a trial membership here: ${config.outreach.membershipUrl}${demo}.`;
}

/** Suggested items pulled from the WF feed, tailored to the contact's specialty when known. */
export function buildSuggestions(contact?: Contact): ItemRequest[] {
  const listings = suggestListings(3, contact?.specialty);
  return listings.map((listing) => ({
    action: listing.type === "FS" ? "buy" : "sell",
    query: listing.item.toLowerCase().startsWith(listing.brand.toLowerCase())
      ? listing.item
      : `${listing.brand} ${listing.item}`,
  }));
}

export function renderSuggestionMenu(suggestions: ItemRequest[]): string {
  const lines = suggestions.map(
    (s, i) => `${i + 1}. ${s.action === "buy" ? "Buy" : "Sell"}: ${s.query}`
  );
  return (
    `Here's what's moving on WF right now:\n${lines.join("\n")}\n\n` +
    `Reply with the numbers you want (e.g. "1,3"), or just tell me up to 3 items you're looking to ` +
    `buy or sell — e.g. "buy: Omega Speedmaster" or "selling: Cartier Love bracelet".`
  );
}

const BUY_KEYWORDS = /\b(buy|buying|wtb|looking for|want|need)\b/i;
const SELL_KEYWORDS = /\b(sell|selling|fs|for sale)\b/i;

function classify(segment: string): ItemRequest | null {
  const text = segment.trim();
  if (!text) return null;
  // Require an explicit buy/sell signal — otherwise plain chatter ("hi", "ok", "thanks")
  // would get misread as an item request and silently burn a trial slot.
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

function parseNumberSelections(text: string): number[] {
  const matches = text.match(/\b[1-3]\b/g) ?? [];
  return [...new Set(matches.map(Number))];
}

function parseFreeTextItems(text: string): ItemRequest[] {
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

export function parseItemRequests(text: string, lastSuggestions?: ItemRequest[]): ItemRequest[] {
  const items: ItemRequest[] = [];
  const seen = new Set<string>();
  const add = (r: ItemRequest) => {
    const key = `${r.action}:${r.query.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(r);
  };

  if (lastSuggestions?.length) {
    for (const n of parseNumberSelections(text)) {
      const pick = lastSuggestions[n - 1];
      if (pick) add(pick);
    }
  }
  for (const r of parseFreeTextItems(text)) add(r);
  return items;
}

export interface FlowResult {
  state: ConversationState;
  messages: string[];
}

/**
 * Pulls queued items through search + consent one at a time (only one pendingReveal can be
 * open at once), then either continues the queue, prompts for the next item, or ends the trial.
 * Mutates `state` and appends to `messages` in place; caller persists + returns the result.
 */
function advance(state: ConversationState, messages: string[]): void {
  while (
    state.itemsRequested.length < config.trial.maxItems &&
    (state.queuedItems?.length ?? 0) > 0 &&
    !state.pendingReveal
  ) {
    const request = state.queuedItems!.shift()!;
    state.itemsRequested.push(request);
    state.itemsCompleted += 1;

    const matches = findMatches(request, config.trial.maxOptionsPerItem);
    const searchingLine =
      request.action === "buy" ? config.outreach.searchingMessageBuyer : config.outreach.searchingMessageSeller;

    if (matches.length === 0) {
      messages.push(`${searchingLine}\n\nNo live matches yet for that one — I'll keep watching the network.`);
      continue;
    }

    const body = matches.map((m, i) => formatMatchAnonymous(m, i)).join("\n");
    messages.push(`${searchingLine}\n\n${body}\n\nHere are the people requesting "${request.query}"… do you want their info?`);
    state.pendingReveal = { request, matches };
    state.stage = "awaiting_reveal_consent";
  }

  if (!state.pendingReveal) {
    if (state.itemsRequested.length >= config.trial.maxItems) {
      state.stage = "trial_ended";
      messages.push(trialEndedMessage());
    } else {
      state.stage = "awaiting_items";
      const left = config.trial.maxItems - state.itemsRequested.length;
      messages.push(`Send me your next item (buy or sell) whenever you're ready — you have ${left} left.`);
    }
  }
}

export function handleIncomingMessage(phone: string, text: string, contact?: Contact): FlowResult {
  const state = getState(phone);

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

  if (state.stage === "trial_ended") {
    return { state, messages: [trialEndedMessage()] };
  }

  const messages: string[] = [];

  if (state.stage === "awaiting_reveal_consent" && state.pendingReveal) {
    const wantsInfo = isAffirmative(text);
    if (wantsInfo) {
      const revealed = state.pendingReveal.matches.map((m, i) => formatMatchRevealed(m, i)).join("\n");
      messages.push(revealed);
    }
    state.pendingReveal = undefined;

    // If they didn't just say yes, treat the message as a possible new item instead of silently dropping it.
    const extra = wantsInfo ? [] : parseItemRequests(text, state.lastSuggestions);
    if (extra.length > 0) {
      const remainingSlots = config.trial.maxItems - state.itemsRequested.length - (state.queuedItems?.length ?? 0);
      state.queuedItems = [...(state.queuedItems ?? []), ...extra.slice(0, Math.max(0, remainingSlots))];
    }

    advance(state, messages);
    saveState(state);
    return { state, messages };
  }

  const parsed = parseItemRequests(text, state.stage === "awaiting_items" ? state.lastSuggestions : undefined);

  if (state.stage === "new" && parsed.length === 0) {
    const suggestions = buildSuggestions(contact);
    state.stage = "awaiting_items";
    state.lastSuggestions = suggestions;
    saveState(state);
    return { state, messages: [renderSuggestionMenu(suggestions)] };
  }

  if (parsed.length === 0) {
    return {
      state,
      messages: [
        'Sorry, I didn\'t catch an item there. Try e.g. "buy: Rolex Daytona" or "selling: Hermes Birkin", or reply with a number from the list above.',
      ],
    };
  }

  const remainingSlots = config.trial.maxItems - state.itemsRequested.length;
  state.queuedItems = [...(state.queuedItems ?? []), ...parsed.slice(0, Math.max(0, remainingSlots))];

  advance(state, messages);
  saveState(state);
  return { state, messages };
}
