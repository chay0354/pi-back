-- Add exposure_level to ads: controls how often the ad is shown in other users' feeds.
-- Values: 'low', 'medium', 'high'. Run in Supabase SQL Editor.

ALTER TABLE ads ADD COLUMN IF NOT EXISTS exposure_level TEXT NOT NULL DEFAULT 'medium'
  CHECK (exposure_level IN ('low', 'medium', 'high'));

CREATE INDEX IF NOT EXISTS idx_ads_exposure_level ON ads(exposure_level) WHERE status = 'published';

COMMENT ON COLUMN ads.exposure_level IS 'Feed visibility: low = fewer impressions, medium = default, high = more impressions';
