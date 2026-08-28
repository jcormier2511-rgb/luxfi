-- Dealer reputation / vouches (spec section 9.1 "Dealer reputation/vouch,
-- when available", and the first-contact message's "Check dealer reputation
-- and references"). Scope decision: vouches are explicit and requested --
-- one party asks their counterparty from a specific completed deal to vouch
-- for them; reputation is a simple count of positive vouches, not a star
-- average. Nothing here is mined from chat history.
CREATE TABLE IF NOT EXISTS dealer_vouches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id),
  -- The party being vouched for (the one who asked for the review).
  subject_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  -- The counterparty being asked to give the vouch.
  voucher_canonical_user_id UUID NOT NULL REFERENCES canonical_users(id),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'given', 'declined')),
  comment TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (subject_canonical_user_id != voucher_canonical_user_id),
  -- One vouch request per deal per subject -- repeated "review me" commands
  -- for the same match are idempotent, not a growing spam queue.
  UNIQUE (match_id, subject_canonical_user_id)
);
CREATE INDEX IF NOT EXISTS dealer_vouches_subject_idx ON dealer_vouches(subject_canonical_user_id);
