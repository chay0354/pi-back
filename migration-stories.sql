-- Stories (separate from ads/listings). Run in Supabase SQL Editor.
-- Each row is one story slide (image); users can have multiple within 24h.

CREATE TABLE IF NOT EXISTS stories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  subscription_id UUID NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  media_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stories_subscription_id_idx ON stories (subscription_id);
CREATE INDEX IF NOT EXISTS stories_created_at_idx ON stories (created_at DESC);

COMMENT ON TABLE stories IS 'Ephemeral story slides (e.g. 24h); not part of ads feed.';
