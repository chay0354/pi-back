-- =============================================================================
-- RUN IN: Supabase Dashboard > SQL Editor > New query
-- PROJECT: the one with URL https://opxeruasowoaybceskyp.supabase.co
-- Fixes: "Could not find the 'is_frozen' column of 'ads' in the schema cache"
--        and other missing columns. After running, wait ~5–10 seconds for
--        schema cache to refresh, or restart the backend.
-- =============================================================================

-- 1) Add columns (run once)
ALTER TABLE ads ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT false;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT false;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS boost_until TIMESTAMPTZ NULL;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS owner_id TEXT NULL;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_ads_owner_id ON ads(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ads_is_frozen ON ads(is_frozen) WHERE is_frozen = false;

-- 2) ad_likes table (for like/unlike)
CREATE TABLE IF NOT EXISTS ad_likes (
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (ad_id, user_id)
);

-- 3) Reload PostgREST schema cache so the API sees the new columns
NOTIFY pgrst, 'reload schema';
SELECT pg_notification_queue_usage();
