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
}

export type RequestAction = "buy" | "sell";

export interface ItemRequest {
  action: RequestAction;
  query: string;
}

export type ConversationStage =
  | "new"
  | "awaiting_items"
  | "matching"
  | "trial_ended"
  | "opted_out";

export interface ConversationState {
  phone: string;
  stage: ConversationStage;
  itemsRequested: ItemRequest[];
  itemsCompleted: number; // how many items have received their match results
  lastSuggestions?: ItemRequest[]; // the 3 suggested items shown, so numeric replies can resolve
  updatedAt: string;
}
