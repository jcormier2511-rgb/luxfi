import { config } from "../config";
import { Contact, ConversationState, ItemRequest } from "../types";
import { findMatches, formatMatch } from "../matching/engine";
import { suggestListings } from "../data/inventoryStore";
import { getState, saveState } from "./stateStore";

const OPT_OUT_WORDS = ["stop", "unsubscribe", "cancel", "opt out", "optout"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isOptOut(text: string): boolean {
  const n = normalize(text);
  return OPT_OUT_WORDS.some((w) => n === w || n.startsWith(`${w} `));
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
    return {
      state,
      messages: [`Your free trial has ended. Start your membership to keep getting matches: ${config.outreach.membershipUrl}`],
    };
  }

  const remainingSlots = config.trial.maxItems - state.itemsRequested.length;

  // First inbound message: try parsing directly in case they jumped straight to naming items;
  // otherwise show the suggestion menu.
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

  const toProcess = parsed.slice(0, Math.max(0, remainingSlots));
  const messages: string[] = [];

  for (const request of toProcess) {
    state.itemsRequested.push(request);
    const matches = findMatches(request, config.trial.maxOptionsPerItem);
    const header = `🔎 Match ${state.itemsRequested.length}/${config.trial.maxItems} — ${request.action === "buy" ? "buying" : "selling"} "${request.query}"`;
    const body =
      matches.length > 0
        ? matches.map((m, i) => formatMatch(m, i)).join("\n")
        : "No live matches yet for that one — I'll keep watching the network.";
    messages.push(`${header}\n${body}`);
    state.itemsCompleted += 1;
  }

  if (state.itemsRequested.length >= config.trial.maxItems) {
    state.stage = "trial_ended";
    messages.push(
      `That's your free trial complete — ${config.trial.maxItems} items matched with up to ${config.trial.maxOptionsPerItem} options each. 🎉\n\n` +
        `To keep getting matches (plus full contact details and review checks), start your LuxFi membership:\n${config.outreach.membershipUrl}`
    );
  } else {
    state.stage = "awaiting_items";
    const left = config.trial.maxItems - state.itemsRequested.length;
    messages.push(`That's ${state.itemsRequested.length}/${config.trial.maxItems} free items used. Send me your next item (buy or sell) whenever you're ready — you have ${left} left.`);
  }

  saveState(state);
  return { state, messages };
}
