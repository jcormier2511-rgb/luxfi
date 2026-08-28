-- Additive migration on top of the pre-existing `sync_meta` table (see 001).
-- Adds independent FS/WTB tracking fields without dropping or renaming any legacy
-- column (spec section 13: "Keep legacy sync_meta columns during this release").
--
-- Column semantics after this migration, per sync_meta row (one row per sync_type):
--   last_sync_at     (legacy) -> last *successful* sync completion time
--   last_sync_status (legacy) -> 'ok' | 'error' | 'disabled'
--   last_sync_error  (legacy) -> last error message, if any
--   sync_count       (legacy) -> total sync attempts recorded
--   last_attempt_at  (new)    -> most recent attempt, successful or not
--   active_count     (new)    -> count of currently active listings from that source
--   enabled          (new)    -> whether this sync type is enabled to run at all

ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS active_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_meta ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- WTB sync stays disabled by default until the authenticated external WTB API request
-- is captured (spec section 2 / 13). This only sets the default for the seeded WTB row;
-- it is idempotent and safe to re-run.
UPDATE sync_meta SET enabled = false, last_sync_status = 'disabled'
WHERE sync_type = 'WTB' AND last_sync_at IS NULL;
