-- Per-party delivery tracking for introductions (spec section 9.3: "Store
-- each party's delivery, decision, confirmation, and connection status
-- independently"). introductions.status/contact_shared_at already give a
-- coarse match-level summary; these two columns record, per direction,
-- whether that specific party has actually been sent the counterparty's
-- contact details yet -- so a repeated approval/confirmation event never
-- re-sends the same contact info twice.
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS fs_party_contact_delivered_at TIMESTAMPTZ;
ALTER TABLE introductions ADD COLUMN IF NOT EXISTS wtb_party_contact_delivered_at TIMESTAMPTZ;
