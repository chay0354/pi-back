-- Monthly published-listing quota per subscription (default 65 without coupon).
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS max_published_listings INTEGER NOT NULL DEFAULT 65;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS promo_code VARCHAR(64);

COMMENT ON COLUMN subscriptions.max_published_listings IS 'Max ads publishable per month for this subscriber';
COMMENT ON COLUMN subscriptions.promo_code IS 'Promo code applied at registration (one per subscription)';

-- Promo codes: bonus_listings is added on top of the default quota (65).
CREATE TABLE IF NOT EXISTS promo_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  bonus_listings INTEGER NOT NULL DEFAULT 0 CHECK (bonus_listings >= 0),
  max_redemptions INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes (is_active) WHERE is_active = true;

-- Example coupons (edit or add more in Supabase SQL editor):
--   PIPLUS20  → 65 + 20 = 85 monthly listings
--   PIPLUS50  → 65 + 50 = 115 monthly listings
INSERT INTO promo_codes (code, bonus_listings, description)
VALUES
  ('PIPLUS20', 20, 'Demo: +20 listings per month'),
  ('PIPLUS50', 50, 'Demo: +50 listings per month')
ON CONFLICT (code) DO NOTHING;
