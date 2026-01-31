-- Migration: Add category field to listings table
-- Run this in Supabase SQL Editor

BEGIN;

-- Add category column to listings table
-- Categories: 1-11 corresponding to tik1.png to tik11.png
ALTER TABLE listings 
ADD COLUMN IF NOT EXISTS category INTEGER CHECK (category >= 1 AND category <= 11);

-- Create index for category filtering
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_category_status ON listings(category, status);

COMMIT;
