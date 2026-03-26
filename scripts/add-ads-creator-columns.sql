-- Run this in Supabase Dashboard > SQL Editor so ads can store uploader name/email.
-- Then when an ad is created, the backend will save creator_name and creator_email from the subscription.

ALTER TABLE ads ADD COLUMN IF NOT EXISTS creator_name text;
ALTER TABLE ads ADD COLUMN IF NOT EXISTS creator_email text;
