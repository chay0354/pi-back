-- Add optional display name and profile picture to chat participants.
-- Used when the participant is not in subscriptions (e.g. "user-xxx" from app registration).
-- Run in Supabase SQL Editor.

ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS display_name TEXT NULL;
ALTER TABLE chat_participants ADD COLUMN IF NOT EXISTS profile_picture_url TEXT NULL;
