-- Post overlay text position (from post editor)
-- Run in Supabase SQL Editor.

ALTER TABLE ads
ADD COLUMN IF NOT EXISTS overlay_x INTEGER NULL;

ALTER TABLE ads
ADD COLUMN IF NOT EXISTS overlay_y INTEGER NULL;

COMMENT ON COLUMN ads.overlay_x IS 'X position of overlay text on post image (from post editor)';
COMMENT ON COLUMN ads.overlay_y IS 'Y position of overlay text on post image (from post editor)';
