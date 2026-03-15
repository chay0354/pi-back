-- Add columns so all 3 ad actions work: הקפאה (freeze), הקפצה (boost), הסרה (remove).
-- Run this in Supabase SQL Editor once.

-- 1) הקפאה (Freeze): hide from feed, still visible to owner in Edit/Publish
ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ads_is_frozen ON ads(is_frozen) WHERE is_frozen = false;
COMMENT ON COLUMN ads.is_frozen IS 'When true, ad is hidden from public feed but still visible to the owner.';

-- 2) הקפצה (Boost): mark as boosted so feed can show it more prominently / first
ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS is_boosted BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS boost_until TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_ads_is_boosted ON ads(is_boosted) WHERE is_boosted = true;
COMMENT ON COLUMN ads.is_boosted IS 'When true, ad can be shown first or in a promoted section in the feed.';
COMMENT ON COLUMN ads.boost_until IS 'Optional: boost expires at this time (NULL = no expiry).';

-- 3) הסרה (Remove): soft-delete; ad is hidden from feed and from owner list
ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ads_is_archived ON ads(is_archived) WHERE is_archived = false;
COMMENT ON COLUMN ads.is_archived IS 'When true, ad is removed (hidden from feed and from owner list).';
