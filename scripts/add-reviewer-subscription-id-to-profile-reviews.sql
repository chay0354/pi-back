-- Add reviewer_subscription_id to link each review to the user (subscription) who wrote it.
-- Run in Supabase SQL Editor after create-profile-reviews-table.sql.
-- If your subscriptions table has a different name, remove the REFERENCES part and add:
--   ADD COLUMN IF NOT EXISTS reviewer_subscription_id UUID;

ALTER TABLE profile_reviews
  ADD COLUMN IF NOT EXISTS reviewer_subscription_id UUID;

CREATE INDEX IF NOT EXISTS idx_profile_reviews_reviewer ON profile_reviews(reviewer_subscription_id);
