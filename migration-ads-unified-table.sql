-- Migration: Single unified ads table with all form fields (20+ form keys → 42+ data columns)
-- All images/videos are stored in Supabase Storage bucket: user-photo-video
-- (Create bucket in Supabase Dashboard > Storage if needed; backend may use user-pohto-video until renamed)
-- Run this in Supabase SQL Editor.
--
-- Form key → DB column(s) mapping (every form field covered):
--   multiimagewithvideo     → main_image_url, additional_image_urls, video_url
--   displayoptions          → display_option
--   propertytype            → property_type
--   generaldetails          → area, rooms, floor, amenities
--   propertycondition       → condition
--   purpose                 → purpose
--   price                    → price (or budget for category 3)
--   address-phone-description → address, phone, description
--   profileverification     → (main image) main_image_url
--   profilepictureupload   → profile_image_url
--   searchpurpose           → search_purpose
--   apartmenttype            → preferred_apartment_type
--   preferences              → preferences, preferred_gender, preferred_age_min, preferred_age_max
--   additionaldetails       → description
--   hospitalitynature       → hospitality_nature
--   serviceandfacility      → service_facility (JSONB)
--   accommodationoffers     → accommodation_offers (JSONB)
--   cancellationpolicy      → cancellation_policy
--   pricepernight           → price_per_night
--   contactdetails          → contact_details (JSONB)
--   proposedland            → proposed_land (JSONB)
--   radiooptions (x5 land)   → plan_approval, land_in_mortgage, permit, agricultural_land, land_ownership
--   landaddress             → land_address
--   salesimage              → sales_image_url
--   saleatpresale            → sale_at_presale
--   generaldetailswithradio → general_details (JSONB), project_offers (JSONB)
--   consructionstatus       → construction_status
--   propertyaddress         → address
--   companyofferslandsizes   → company_offers_land_sizes (JSONB)
-- Plus: subscription_id, subscription_type, category, status (metadata).

-- Drop existing ads table if re-running (optional; comment out if you need to preserve data)
-- DROP TABLE IF EXISTS listing_videos;
-- DROP TABLE IF EXISTS listing_images;
-- DROP TABLE IF EXISTS ads;

CREATE TABLE IF NOT EXISTS ads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Who posted (optional; link to subscriptions later)
  subscription_id UUID NULL,
  subscription_type VARCHAR(20) NULL CHECK (subscription_type IN ('user', 'broker', 'company', 'professional')),

  -- Category (1-12) and status
  category INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published')),

  -- ========== MEDIA (references to bucket user-photo-video) ==========
  main_image_url TEXT NULL,
  additional_image_urls JSONB DEFAULT '[]'::jsonb,
  video_url TEXT NULL,
  sales_image_url TEXT NULL,
  profile_image_url TEXT NULL,

  -- ========== DISPLAY ==========
  display_option VARCHAR(20) NULL,

  -- ========== PROPERTY BASICS (all forms) ==========
  property_type VARCHAR(80) NULL,
  area INTEGER NULL,
  rooms INTEGER NULL,
  floor INTEGER NULL,
  purpose VARCHAR(20) NULL DEFAULT 'sale',
  price DECIMAL(14,2) NULL,
  budget DECIMAL(14,2) NULL,
  price_per_night DECIMAL(14,2) NULL,

  -- ========== GENERAL DETAILS ==========
  amenities JSONB NULL,
  condition VARCHAR(80) NULL,
  address TEXT NULL,
  phone VARCHAR(50) NULL,
  description TEXT NULL,

  -- ========== CATEGORY 3 - PARTNERS (שותפים) ==========
  search_purpose VARCHAR(80) NULL,
  preferred_apartment_type VARCHAR(80) NULL,
  preferred_gender VARCHAR(20) NULL,
  preferred_age_min INTEGER NULL,
  preferred_age_max INTEGER NULL,
  preferences JSONB NULL,

  -- ========== BNB / HOSPITALITY (category 5) ==========
  hospitality_nature VARCHAR(80) NULL,
  service_facility JSONB NULL,
  accommodation_offers JSONB NULL,
  cancellation_policy VARCHAR(80) NULL,
  contact_details JSONB NULL,

  -- ========== LAND (קרקעות, category 7 etc.) ==========
  proposed_land JSONB NULL,
  plan_approval VARCHAR(50) NULL,
  land_in_mortgage VARCHAR(20) NULL,
  permit VARCHAR(50) NULL,
  agricultural_land VARCHAR(20) NULL,
  land_ownership VARCHAR(50) NULL,
  land_address TEXT NULL,

  -- ========== BROKER / COMPANY PROJECT ==========
  construction_status VARCHAR(80) NULL,
  sale_at_presale BOOLEAN NULL,
  general_details JSONB NULL,
  project_offers JSONB NULL,
  company_offers_land_sizes JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status);
CREATE INDEX IF NOT EXISTS idx_ads_category ON ads(category);
CREATE INDEX IF NOT EXISTS idx_ads_created_at ON ads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ads_subscription_type ON ads(subscription_type);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_ads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_ads_updated_at ON ads;
CREATE TRIGGER update_ads_updated_at
  BEFORE UPDATE ON ads
  FOR EACH ROW EXECUTE FUNCTION update_ads_updated_at();

-- Optional: enable RLS (Row Level Security) later
-- ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
