-- Optional image attachment on post comments (TikTok comment camera)
-- Run in Supabase SQL Editor

ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS comment_image_url TEXT;
