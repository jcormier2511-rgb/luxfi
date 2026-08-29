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

export type SellIntakeStep = "details" | "price" | "photo";

/**
 * A "sell" request doesn't search anything live yet (there's no automatic buyer-matching for a
 * self-reported listing) — instead Fi collects what it needs to actually describe the item to a
 * future buyer: enough identifying detail (brand/model/reference), a price, and a photo. Walks
 * one question at a time, same pattern as PendingPreferenceCollection.
 */
export interface PendingSellIntake {
  step: SellIntakeStep;
  description: string; // accumulated free-text description, starting from the original message
  reference: string | null;
  price?: number;
  priceText?: string; // the raw reply, kept for display when the number couldn't be parsed
  imageUrl?: string;
}

export interface ConversationState {
  phone: string;
  stage: ConversationStage;
  // Approval usage (trial + weekly plan cap) is NOT tracked here — it lives in Postgres
  // (canonical_users.total_approved_count / account_entitlements, see postings/
  // approvalUsage.ts) as the single shared counter between this on-demand flow and the v4
  // automatic-matching flow, so a canonical account can't exhaust its trial twice under two
  // separate counters. Read it live via getApprovalUsage(phone) rather than caching it here.
  hired: boolean; // said "join" after the trial — informational only; does NOT unlock approvals.
  // The actual gate is account_entitlements (Postgres, admin-only — see src/billing/
  // entitlementStore.ts / postings/approvalUsage.ts). Kept here to remember expressed interest.
  pendingMatches?: PendingMatchSet;
  preferencesCollected: boolean;
  preferences?: SearchPreferences;
  pendingPreferenceCollection?: PendingPreferenceCollection;
  pendingNaturalFollowUp?: PendingNaturalFollowUp;
  pendingSellIntake?: PendingSellIntake;
  // Set right after a real connection reveal suggests escrow/inspection partners (see
  // config.fiFlow.escrowSuggestion) — checked once, on the contact's very next reply, so a
  // bare "yes" is recognized as accepting the offer (see conversation/flow.ts's handling and
  // stateStore.ts's markPendingEscrowOffer, used by both this flow and the v4 automatic-
  // matching flow's own reveal points in server.ts/postings/notify.ts). Cleared after that one
  // reply regardless of what it was — never nags on a later, unrelated message.
  pendingEscrowOffer?: boolean;
  // Automatic currency conversion (src/fx/) — set via "Show prices in USD" / "Use HKD as my
  // preferred currency" (see conversation/flow.ts). ISO 4217 code. Undefined means the
  // config-wide DEFAULT_DISPLAY_CURRENCY is used instead.
  preferredDisplayCurrency?: string;
  updatedAt: string;
}
