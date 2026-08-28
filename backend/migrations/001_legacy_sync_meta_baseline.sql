-- Baseline representing the pre-existing production `sync_meta` inventory-sync tracking
-- table. Real production systems referenced by the Fi Build Specification v4 already have
-- a table like this; it is recreated here so the additive migration in 003 has a realistic
-- legacy shape to migrate on top of, and so the "migration succeeds against the existing
-- legacy sync_meta schema" acceptance test has something concrete to exercise.
--
-- Do not drop or rename these columns in this release (spec section 13).
CREATE TABLE IF NOT EXISTS sync_meta (
  id SERIAL PRIMARY KEY,
  sync_type TEXT NOT NULL UNIQUE,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_error TEXT,
  sync_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sync_meta (sync_type, sync_count)
VALUES ('FS', 0), ('WTB', 0)
ON CONFLICT (sync_type) DO NOTHING;
