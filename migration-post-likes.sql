-- Add separate likes storage for feed posts (independent from ad_likes / ads.like_count)
-- Run in Supabase SQL Editor.

-- Counter for post likes (kept separate from ads.like_count)
ALTER TABLE ads
ADD COLUMN IF NOT EXISTS post_like_count INTEGER NOT NULL DEFAULT 0;

-- Per-user likes for posts only
CREATE TABLE IF NOT EXISTS post_likes (
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_user_id ON post_likes(user_id);
