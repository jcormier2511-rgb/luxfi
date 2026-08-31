export type Platform = 'whatsapp' | 'telegram' | 'sms' | 'email';
export type SourceType = 'chat' | 'api';
export type PostingType = 'FS' | 'WTB';

export type PostingStatus =
  | 'active'
  | 'completed_match_limit'
  | 'sold'
  | 'found'
  | 'stopped'
  | 'expired'
  | 'source_inactive'
  | 'admin_closed';

export const MONITOR_TERMINAL_STATUSES: PostingStatus[] = [
  'completed_match_limit',
  'sold',
  'found',
  'stopped',
  'expired',
  'source_inactive',
  'admin_closed',
];

export interface ContactMethod {
  type: 'whatsapp' | 'telegram' | 'phone' | 'email';
  value: string;
  authorizedForSharing: boolean;
}

export interface NormalizedPostingAttributes {
  brand?: string;
  model?: string;
  referenceNumber?: string;
  dial?: string;
  material?: string;
  year?: number;
  condition?: string;
  boxPapers?: string;
  otherAttributes?: Record<string, unknown>;
  askingPrice?: number;
  maxBid?: number;
  currency?: string;
  location?: string;
  country?: string;
  contactName?: string;
  contactMethods?: ContactMethod[];
  detailUrl?: string;
  normalizationConfidence?: number;
  extractionVersion?: string;
}

export interface ChatPostingInput extends NormalizedPostingAttributes {
  sourceType: 'chat';
  platform: Platform;
  chatId: string;
  messageId: string;
  postingType: PostingType;
  originalMessage: string;
  originalDescription?: string;
  senderPlatformUserId: string;
  senderDisplayName?: string;
}

export interface ApiPostingInput extends NormalizedPostingAttributes {
  sourceType: 'api';
  platform: 'watchfacts';
  postingType: PostingType;
  externalListingId: string;
  originalDescription?: string;
  /** Canonical user to attribute this listing to, when known. Provisional otherwise. */
  ownerCanonicalUserId?: string;
}

export interface Posting {
  id: string;
  canonicalUserId: string;
  sourcePlatform: string;
  sourceType: SourceType;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  externalListingId: string | null;
  postingType: PostingType;
  originalMessage: string | null;
  originalDescription: string | null;
  brand: string | null;
  model: string | null;
  referenceNumber: string | null;
  dial: string | null;
  material: string | null;
  year: number | null;
  condition: string | null;
  boxPapers: string | null;
  otherAttributes: Record<string, unknown>;
  askingPrice: number | null;
  maxBid: number | null;
  currency: string | null;
  location: string | null;
  country: string | null;
  contactName: string | null;
  contactMethods: ContactMethod[];
  detailUrl: string | null;
  status: PostingStatus;
  approvedMatchCount: number;
  normalizationConfidence: number | null;
  extractionVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  extensionReminderSentAt: Date | null;
}

export interface MatchRecord {
  id: string;
  fsPostingId: string;
  wtbPostingId: string;
  score: number;
  matchingVersion: string;
  reasons: string[];
  revision: number;
  status: 'surfaced' | 'approved' | 'passed_all' | 'superseded';
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalResult {
  matchId: string;
  approvingCanonicalUserId: string;
  isComplimentary: boolean;
  ledgerEntryId: string | null;
  duplicate: boolean;
}

export const MATCHING_VERSION = 'v1';
export const MONITOR_APPROVED_MATCH_LIMIT = 5;
export const ACCOUNT_COMPLIMENTARY_APPROVAL_LIMIT = 3;
export const DEFAULT_MONITOR_LIFETIME_DAYS = 30;
export const DEFAULT_EXTENSION_REMINDER_DAYS = 3;
