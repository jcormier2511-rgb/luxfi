export type Tier = "A" | "B" | "C";

export interface Contact {
  phone: string;
  name: string;
  tier: Tier;
  specialty?: string;
  wfProfileId?: string; // WatchFacts profile-listings id, e.g. watchfacts.com/profile-listings?profileId=830
}

export type ListingType = "FS" | "WTB"; // For Sale / Want To Buy

export interface InventoryListing {
  id: string;
  type: ListingType;
  category: string;
  item: string;
  brand: string;
  ref: string;
  condition: string;
  price: string;
  location: string;
  contactName: string;
  contactPhone: string;
  source: string;
  rating: string;
  description: string; // full original listing text, e.g. from the WF detail page — richer than `item`
  detailUrl?: string; // e.g. https://watchfacts.com/flash-sales/<id> — optional, WF listings only
  imageUrl?: string; // primary photo — WatchFacts' own frontImage, when the API provided one
  // Automatic currency conversion (src/fx/) — the listing's OWN stated price/currency, read
  // directly from its title/description, kept separate from `price` above (which stays the
  // plain numeric string every existing price-parsing/filter path already relies on) so the
  // original is never overwritten by a converted value. Undefined when the text named no
  // unambiguous price of its own (falls back to `price` as today).
  nativePriceAmount?: number;
  nativeCurrency?: string; // ISO 4217 code, e.g. "HKD"
  originalPriceText?: string; // verbatim substring, e.g. "HK$850,000"
}

export type RequestAction = "buy" | "sell";

export interface ItemRequest {
  action: RequestAction;
  query: string;
}

export type MatchDecision = "pending" | "approved" | "passed";

/**
 * The most recent search's results, awaiting "approve <n>" / "pass <n>" replies. Only one
 * set is live at a time — starting a new search replaces it, undecided entries just lapse.
 */
export interface PendingMatchSet {
  request: ItemRequest;
  matches: InventoryListing[];
  decisions: MatchDecision[]; // parallel to `matches`
}

export type ConversationStage = "new" | "active" | "opted_out";

/** Collected once per contact on their first search, then reused for every later search. */
export interface SearchPreferences {
  priceMin?: number;
  priceMax?: number;
  location?: string;
  dialColor?: string;
  condition?: string;
}

export type PreferenceStep = "price" | "location" | "dial" | "condition";

/** Mid-collection state — which question is outstanding and the item request waiting on it. */
export interface PendingPreferenceCollection {
  step: PreferenceStep;
  request: ItemRequest;
}

/**
 * Fi Concierge Stage 3: a single free-form message can skip the old step-by-step interview
 * (see flow.ts's tryNaturalLanguagePreferences), but a request must still always carry price,
 * location, dial color, and condition — those are asked for as one follow-up question naming
 * only what's actually missing, never re-asked one-at-a-time. `missing` is the human-readable
 * labels shown in that question (e.g. "budget", "location"); `partial` is whatever the AI
 * already extracted from the original message, kept as-is and only ever filled in, never
 * overwritten, by the follow-up reply.
 */
export interface PendingNaturalFollowUp {
  request: ItemRequest;
  partial: SearchPreferences;
  missing: string[];
}

export interface ConversationState {
  phone: string;
  stage: ConversationStage;
  approvedCount: number; // trial = TRIAL_MAX_APPROVED_MATCHES approved matches, not searches
  hired: boolean; // said "join" after the trial — informational only; does NOT unlock approvals.
  // The actual gate is account_entitlements.manual_override_enabled (Postgres, admin-only —
  // see src/billing/entitlementStore.ts). Kept here to remember they've expressed interest.
  pendingMatches?: PendingMatchSet;
  preferencesCollected: boolean;
  preferences?: SearchPreferences;
  pendingPreferenceCollection?: PendingPreferenceCollection;
  pendingNaturalFollowUp?: PendingNaturalFollowUp;
  updatedAt: string;
}
