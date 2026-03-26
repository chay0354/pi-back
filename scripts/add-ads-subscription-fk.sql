-- Run this in Supabase Dashboard > SQL Editor.
-- Creates the DB connection (foreign key) between ads and subscriptions:
-- each ad is linked to the subscription (uploader) that owns it.

-- Step 1: Optional - set subscription_id to NULL for ads whose subscription no longer exists (orphans).
-- Uncomment the next 2 lines if you get "violates foreign key" when adding the constraint:
-- UPDATE ads SET subscription_id = NULL, owner_id = NULL
-- WHERE subscription_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = ads.subscription_id);

-- Step 2: Add foreign key (ads.subscription_id -> subscriptions.id)
ALTER TABLE ads DROP CONSTRAINT IF EXISTS fk_ads_subscription;

ALTER TABLE ads
  ADD CONSTRAINT fk_ads_subscription
  FOREIGN KEY (subscription_id)
  REFERENCES subscriptions(id)
  ON DELETE RESTRICT;

-- Step 3: Index for fast lookups when loading creator by subscription_id
CREATE INDEX IF NOT EXISTS idx_ads_subscription_id ON ads(subscription_id);
