-- Migration: Add category 3 (חדש מקבלן) specific fields to listings table
-- Run this in Supabase SQL Editor
-- Category 3 is for shared apartment listings with different fields

BEGIN;

-- Add category 3 specific fields to listings table
-- These fields are only used when category = 3

-- Search purpose: 'enter', 'bring_in', 'partner'
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS search_purpose VARCHAR(50) CHECK (search_purpose IN ('enter', 'bring_in', 'partner'));

-- Preferred apartment type: 'regular', 'studio', 'garden', 'duplex', 'penthouse', 'private'
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS preferred_apartment_type VARCHAR(50) CHECK (preferred_apartment_type IN ('regular', 'studio', 'garden', 'duplex', 'penthouse', 'private'));

-- Preferred gender: 'female', 'male'
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS preferred_gender VARCHAR(20) CHECK (preferred_gender IN ('female', 'male'));

-- Preferred age range
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS preferred_age_min INTEGER CHECK (preferred_age_min >= 18 AND preferred_age_min <= 100);

ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS preferred_age_max INTEGER CHECK (preferred_age_max >= 18 AND preferred_age_max <= 100);

-- Preferences (JSONB for flexible storage of checkboxes)
-- Example: {"nonSmokers": true, "students": false, "stableJob": true, ...}
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}';

-- Budget (for category 3, this is the main price field)
-- Note: We already have 'price' column, but budget is more specific for category 3
-- We can use price for budget, but adding this for clarity
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS budget DECIMAL(12, 2);

-- Make existing fields nullable for category 3 (since they don't apply)
-- Note: We'll handle validation in the backend, but making them nullable allows category 3 listings
-- For category 3, these fields can be NULL:
-- - address (not required)
-- - phone (not required)
-- - property_type (has default)
-- - area, rooms, floor (have defaults)

-- Update address and phone to be nullable (they're not required for category 3)
ALTER TABLE listings 
ALTER COLUMN address DROP NOT NULL;

ALTER TABLE listings 
ALTER COLUMN phone DROP NOT NULL;

-- Create indexes for category 3 filtering
CREATE INDEX IF NOT EXISTS idx_listings_search_purpose ON listings(search_purpose) WHERE search_purpose IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_preferred_apartment_type ON listings(preferred_apartment_type) WHERE preferred_apartment_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_preferred_gender ON listings(preferred_gender) WHERE preferred_gender IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_category3 ON listings(category) WHERE category = 3;

COMMIT;
