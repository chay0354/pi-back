-- Chat media: images and voice in Storage bucket "chat".
-- 1) Run this file in Supabase SQL Editor.
-- 2) Dashboard → Storage → New bucket → name: chat → Public bucket (so getPublicUrl works for clients), or keep private and switch to signed URLs later.
-- 3) Backend uses SUPABASE_SERVICE_ROLE_KEY to upload.

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_type TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url TEXT NULL;

COMMENT ON COLUMN chat_messages.media_type IS 'image | audio when message includes uploaded media';
COMMENT ON COLUMN chat_messages.media_url IS 'Public URL in storage bucket chat';
