-- Listing boost system:
-- Each user (subscription) can "boost" an ad to high exposure for 24 hours.
-- Users have a monthly quota (2 boosts per calendar month).
-- Run in Supabase SQL Editor.

-- 1) boost_expires_at on ads: when set in the future, the ad is currently boosted.
ALTER TABLE ads ADD COLUMN IF NOT EXISTS boost_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ads_boost_expires_at ON ads(boost_expires_at) WHERE boost_expires_at IS NOT NULL;

COMMENT ON COLUMN ads.boost_expires_at IS 'When set in the future, the listing is treated as HIGH exposure until this time.';

-- 2) Log table to track boosts per subscription per month for quota enforcement.
CREATE TABLE IF NOT EXISTS listing_boosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL,
  ad_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_boosts_subscription_month
  ON listing_boosts(subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_boosts_ad ON listing_boosts(ad_id);

COMMENT ON TABLE listing_boosts IS 'History of ad boosts. Used to enforce per-month quotas (default 2 per calendar month per subscription).';
