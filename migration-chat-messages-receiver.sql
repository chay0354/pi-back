-- Store receiver on each message so we can show "conversations where someone sent to me" on the receiving end.
-- Run in Supabase SQL Editor.

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS receiver_id TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_receiver ON chat_messages(receiver_id) WHERE receiver_id IS NOT NULL;
