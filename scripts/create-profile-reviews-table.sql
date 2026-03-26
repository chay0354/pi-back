-- Profile reviews: ratings and comments for a subscription (broker/agency) profile.
-- Run this in Supabase SQL Editor to create the table.
-- If subscriptions table has a different name or you prefer no FK, use:
--   target_subscription_id UUID NOT NULL

CREATE TABLE IF NOT EXISTS profile_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_subscription_id UUID NOT NULL,
  reviewer_name TEXT,
  reviewer_image_url TEXT,
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for listing reviews by profile
CREATE INDEX IF NOT EXISTS idx_profile_reviews_target ON profile_reviews(target_subscription_id);
CREATE INDEX IF NOT EXISTS idx_profile_reviews_created ON profile_reviews(created_at DESC);

-- Optional: RLS (Row Level Security) – enable if you want to restrict who can read/write
-- ALTER TABLE profile_reviews ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Anyone can read reviews" ON profile_reviews FOR SELECT USING (true);
-- CREATE POLICY "Anyone can insert review" ON profile_reviews FOR INSERT WITH CHECK (true);
