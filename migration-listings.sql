-- Listings and related tables for office/property listings
-- Run this in Supabase SQL Editor if listings tables don't exist yet.

-- Listings main table
CREATE TABLE IF NOT EXISTS listings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  property_type VARCHAR(50),
  area INTEGER,
  rooms INTEGER,
  floor INTEGER,
  purpose VARCHAR(20) DEFAULT 'sale',
  price DECIMAL(12,2),
  budget DECIMAL(12,2),
  address TEXT,
  phone VARCHAR(50),
  description TEXT,
  display_option VARCHAR(20),
  amenities JSONB,
  condition VARCHAR(50),
  search_purpose VARCHAR(50),
  preferred_apartment_type VARCHAR(50),
  preferred_gender VARCHAR(20),
  preferred_age_min INTEGER,
  preferred_age_max INTEGER,
  preferences JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);

-- Listing images (main + additional)
CREATE TABLE IF NOT EXISTS listing_images (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  image_type VARCHAR(20) NOT NULL DEFAULT 'additional' CHECK (image_type IN ('main', 'additional')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_images_listing_id ON listing_images(listing_id);

-- Listing videos
CREATE TABLE IF NOT EXISTS listing_videos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  video_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_videos_listing_id ON listing_videos(listing_id);

-- Trigger to update updated_at on listings
CREATE OR REPLACE FUNCTION update_listings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_listings_updated_at ON listings;
CREATE TRIGGER update_listings_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_listings_updated_at();
