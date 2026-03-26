-- Add feed_display_priority to ads table (TikTok feed: show video or main image first)
-- Run in Supabase SQL Editor.

ALTER TABLE ads
ADD COLUMN IF NOT EXISTS feed_display_priority VARCHAR(20) NULL;

COMMENT ON COLUMN ads.feed_display_priority IS 'For TikTok feed: ''video'' = show video first when both exist, ''mainImage'' = show main image first';
