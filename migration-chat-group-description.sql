-- Optional group description (shown in group chat info card).
-- Run in Supabase SQL Editor.

ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_description TEXT NULL;
