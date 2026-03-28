-- Optional group avatar for chat_conversations (broker/customer groups).
-- Run in Supabase SQL Editor.

ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_image_url TEXT NULL;
