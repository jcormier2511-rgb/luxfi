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
  updatedAt: string;
}
