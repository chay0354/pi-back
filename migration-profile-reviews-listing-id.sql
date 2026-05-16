-- Tie profile reviews to a specific published ad when the user rates from that listing's profile.
-- Run in Supabase SQL Editor after profile_reviews exists.

ALTER TABLE profile_reviews
ADD COLUMN IF NOT EXISTS listing_id UUID NULL REFERENCES ads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profile_reviews_listing_id ON profile_reviews(listing_id)
WHERE listing_id IS NOT NULL;

COMMENT ON COLUMN profile_reviews.listing_id IS 'When set, this review counts toward that ad only (owner Edit/Publish stats).';
