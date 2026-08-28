-- Core Fi matching/conversation schema (spec section 12).
-- PostgreSQL is the system of record; CSV is never an authoritative source.
-- Uses DB-level constraints (unique indexes, checks, FKs) for money, trial usage,
-- approval counts, and introductions -- not application checks alone (spec section 12).

CREATE TABLE IF NOT EXISTS canonical_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT,
  first_name TEXT,
  is_provisional BOOLEAN NOT NULL DEFAULT false,
  trial_approvals_used INTEGER NOT NULL DEFAULT 0 CHECK (trial_approvals_used >= 0),
  first_contact_sent_at TIMESTAMPTZ,
  -- Set when this account was merged into another canonical account (spec section 5.2).
  -- A merged account is a tombstone: its identities/history are reassigned to the target.
  merged_into_id UUID REFERENCES canonical_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  chat_id TEXT,
  display_name TEXT,
  is_provisional BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS platform_identities_canonical_user_idx
  ON platform_identities(canonical_user_id);

CREATE TABLE IF NOT EXISTS monitored_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  is_watchfacts_administered BOOLEAN NOT NULL DEFAULT false,
  eligibility_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (eligibility_status IN ('eligible', 'not_eligible', 'pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, chat_id)
);

CREATE TABLE IF NOT EXISTS postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  source_platform TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('chat', 'api')),
  source_chat_id TEXT,
  source_message_id TEXT,
  external_listing_id TEXT,
  posting_type TEXT NOT NULL CHECK (posting_type IN ('FS', 'WTB')),
  original_message TEXT,
  original_description TEXT,
  brand TEXT,
  model TEXT,
  reference_number TEXT,
  dial TEXT,
  material TEXT,
  year INTEGER,
  condition TEXT,
  box_papers TEXT,
  other_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  asking_price NUMERIC(14, 2),
  max_bid NUMERIC(14, 2),
  currency TEXT,
  location TEXT,
  country TEXT,
  contact_name TEXT,
  contact_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'completed_match_limit', 'sold', 'found', 'stopped',
    'expired', 'source_inactive', 'admin_closed'
  )),
  approved_match_count INTEGER NOT NULL DEFAULT 0 CHECK (approved_match_count >= 0),
  normalization_confidence NUMERIC(4, 3),
  extraction_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  extension_reminder_sent_at TIMESTAMPTZ,
  CHECK (
    (source_type = 'chat' AND source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
    OR
    (source_type = 'api' AND external_listing_id IS NOT NULL)
  )
);

-- Source-specific idempotency keys (spec section 5.1 / 12).
CREATE UNIQUE INDEX IF NOT EXISTS postings_chat_identity_uq
  ON postings (source_platform, source_chat_id, source_message_id)
  WHERE source_type = 'chat';

CREATE UNIQUE INDEX IF NOT EXISTS postings_api_identity_uq
  ON postings (source_platform, posting_type, external_listing_id)
  WHERE source_type = 'api';

CREATE INDEX IF NOT EXISTS postings_canonical_user_idx ON postings(canonical_user_id);
CREATE INDEX IF NOT EXISTS postings_matching_idx ON postings(posting_type, status, expires_at);
CREATE INDEX IF NOT EXISTS postings_reference_idx ON postings(reference_number);

CREATE TABLE IF NOT EXISTS posting_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id UUID NOT NULL REFERENCES postings(id) ON DELETE CASCADE,
  source_media_id TEXT,
  source_url TEXT,
  storage_key TEXT,
  mime_type TEXT,
  file_size INTEGER,
  content_hash TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (posting_id, content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS posting_images_primary_uq
  ON posting_images(posting_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fs_posting_id UUID NOT NULL REFERENCES postings(id),
  wtb_posting_id UUID NOT NULL REFERENCES postings(id),
  score NUMERIC(6, 2) NOT NULL,
  matching_version TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'surfaced'
    CHECK (status IN ('surfaced', 'approved', 'passed_all', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fs_posting_id, wtb_posting_id)
);
CREATE INDEX IF NOT EXISTS matches_fs_idx ON matches(fs_posting_id);
CREATE INDEX IF NOT EXISTS matches_wtb_idx ON matches(wtb_posting_id);

CREATE TABLE IF NOT EXISTS match_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  recipient_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  match_revision INTEGER NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'passed')),
  delivered_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, recipient_canonical_user_id, match_revision)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  recipient_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  match_revision INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stub',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique notification identity: match ID + recipient ID + match revision (spec section 12).
  UNIQUE (match_id, recipient_canonical_user_id, match_revision)
);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  match_id UUID REFERENCES matches(id),
  entry_type TEXT NOT NULL
    CHECK (entry_type IN ('complimentary_approval', 'paid_approval', 'membership_fee')),
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  -- MVP note: 'charged' is reserved for a future real payment-processor integration.
  -- No code path in this release is permitted to set 'charged' -- see payment.adapter.ts.
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'pending_billing', 'charged', 'waived')),
  processor_charge_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_ledger_user_idx ON billing_ledger(canonical_user_id);

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  approving_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  is_complimentary BOOLEAN NOT NULL,
  ledger_entry_id UUID REFERENCES billing_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Unique approval/billing identity: match ID + approving canonical user ID (spec section 12).
  UNIQUE (match_id, approving_canonical_user_id)
);

CREATE TABLE IF NOT EXISTS passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  recipient_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, recipient_canonical_user_id)
);

CREATE TABLE IF NOT EXISTS counterparty_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  counterparty_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  confirmed BOOLEAN NOT NULL DEFAULT false,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (match_id, counterparty_canonical_user_id)
);

CREATE TABLE IF NOT EXISTS introductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL UNIQUE REFERENCES matches(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'contact_shared', 'completed')),
  fs_party_canonical_user_id UUID REFERENCES canonical_users(id),
  wtb_party_canonical_user_id UUID REFERENCES canonical_users(id),
  contact_shared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Membership entitlements: schema/interface preserved for payment-processor and
-- WatchFacts membership-verification integration, but neither is wired up live in
-- this release (see task instructions: defer both, never attempt a live charge).
CREATE TABLE IF NOT EXISTS membership_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_user_id UUID NOT NULL UNIQUE REFERENCES canonical_users(id),
  fi_membership_status TEXT NOT NULL DEFAULT 'trial'
    CHECK (fi_membership_status IN ('trial', 'locked', 'active', 'waived_via_watchfacts')),
  watchfacts_member_verified BOOLEAN NOT NULL DEFAULT false,
  watchfacts_verification_source TEXT NOT NULL DEFAULT 'unverified'
    CHECK (watchfacts_verification_source IN ('unverified', 'manual_admin', 'api_integration')),
  payment_authorization_status TEXT NOT NULL DEFAULT 'none'
    CHECK (payment_authorization_status IN ('none', 'pending_integration', 'authorized')),
  -- Manual entitlement override: lets an administrator unlock approvals for a specific
  -- account (testing / early users) without any payment processor being wired up.
  manual_override_enabled BOOLEAN NOT NULL DEFAULT false,
  manual_override_by TEXT,
  manual_override_reason TEXT,
  manual_override_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
