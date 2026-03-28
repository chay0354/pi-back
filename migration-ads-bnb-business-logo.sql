-- BnB business listing: optional logo URL (category 5, bnb_host_type = business in general_details)
-- Run in Supabase SQL Editor after main ads migration.

ALTER TABLE ads ADD COLUMN IF NOT EXISTS bnb_business_logo_url TEXT NULL;

COMMENT ON COLUMN ads.bnb_business_logo_url IS 'Logo image URL for BnB ads published as business (listings/images in storage)';
