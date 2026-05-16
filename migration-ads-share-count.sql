-- Add share_count to ads to track how many times a post/listing was shared via chat.
-- Run in Supabase SQL Editor.

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS share_count INTEGER NOT NULL DEFAULT 0;

-- (Optional) index if you ever want to sort/filter by share_count
CREATE INDEX IF NOT EXISTS idx_ads_share_count ON ads(share_count);

-- share_count is updated by the backend API when a user shares via the SharePostSheet
-- (POST /api/listings/:id/share). No trigger is needed.
