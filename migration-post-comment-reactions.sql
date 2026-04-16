-- Comment likes/dislikes reactions for post comments
-- Run in Supabase SQL Editor

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS dislikes_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS post_comment_reactions (
  comment_id UUID NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  ad_id UUID NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('like', 'dislike')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_post_comment_reactions_ad_id
ON post_comment_reactions(ad_id);

CREATE INDEX IF NOT EXISTS idx_post_comment_reactions_user_id
ON post_comment_reactions(user_id);
