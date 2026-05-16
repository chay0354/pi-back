-- Feed posts (TikTok-style) vs property ads — required for POST body feedPost / description "פוסט"
-- Run in Supabase SQL Editor if listingAdRecord sets feed_post but rows stay "ad-like".

ALTER TABLE ads
ADD COLUMN IF NOT EXISTS feed_post BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ads_feed_post ON ads(feed_post) WHERE feed_post = true;

COMMENT ON COLUMN ads.feed_post IS 'True when row is a feed post (image/text post), not a full property listing';
