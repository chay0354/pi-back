-- Migration: Add listings tables for Supabase
-- Run this in Supabase SQL Editor

BEGIN;

-- 1. Create listings table (using UUID to match subscriptions table)
CREATE TABLE IF NOT EXISTS listings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  property_type VARCHAR(50) NOT NULL CHECK (property_type IN ('office', 'floor')),
  area INTEGER NOT NULL,
  rooms INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  condition VARCHAR(50) CHECK (condition IN ('ישן', 'משופץ', 'חדש')),
  purpose VARCHAR(50) NOT NULL CHECK (purpose IN ('sale', 'rent')),
  price DECIMAL(12, 2) NOT NULL,
  address TEXT NOT NULL,
  phone VARCHAR(20) NOT NULL,
  description TEXT NOT NULL,
  display_option VARCHAR(50) CHECK (display_option IN ('collage', 'slideshow')),
  has_video BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Create listing_amenities table
CREATE TABLE IF NOT EXISTS listing_amenities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  amenity_name VARCHAR(100) NOT NULL,
  quantity INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Create listing_images table
CREATE TABLE IF NOT EXISTS listing_images (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  image_type VARCHAR(20) NOT NULL CHECK (image_type IN ('main', 'additional')),
  display_order INTEGER DEFAULT 0,
  file_name VARCHAR(255),
  file_size INTEGER,
  mime_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Create listing_videos table
CREATE TABLE IF NOT EXISTS listing_videos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  file_name VARCHAR(255),
  file_size BIGINT,
  mime_type VARCHAR(50),
  duration INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_listings_user_id ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listing_amenities_listing_id ON listing_amenities(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_images_listing_id ON listing_images(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_images_type ON listing_images(listing_id, image_type, display_order);
CREATE INDEX IF NOT EXISTS idx_listing_videos_listing_id ON listing_videos(listing_id);

-- Create trigger to update updated_at
CREATE OR REPLACE FUNCTION update_listings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_listings_updated_at
    BEFORE UPDATE ON listings
    FOR EACH ROW
    EXECUTE FUNCTION update_listings_updated_at();

COMMIT;
