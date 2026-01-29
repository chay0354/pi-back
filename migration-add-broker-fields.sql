-- Migration: Add broker-specific fields to subscriptions table
-- Run this SQL in your Supabase SQL Editor

-- Add broker-specific columns if they don't exist
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS brokerage_license_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS broker_office_name VARCHAR(255);

-- Verify the columns were added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'subscriptions' 
AND column_name IN ('brokerage_license_number', 'broker_office_name');
