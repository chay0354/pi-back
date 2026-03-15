-- Add view_count and like_count to ads; add ad_likes for per-user like state.
-- Run in Supabase SQL Editor.

-- Add columns to ads if not present
ALTER TABLE ads ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0;

-- Table to track who liked which ad (so we can toggle and show "liked" state)
CREATE TABLE IF NOT EXISTS ad_likes (
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ad_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_likes_user_id ON ad_likes(user_id);

-- like_count is updated by the backend API when liking/unliking (no trigger).
