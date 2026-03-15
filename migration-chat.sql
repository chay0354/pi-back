-- PiChat: conversations and messages for the chat system.
-- Run in Supabase SQL Editor (project: opxeruasowoaybceskyp).

-- Conversations (chat rooms). Can be 1:1 or group; type can be extended later.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type VARCHAR(20) DEFAULT 'direct' CHECK (type IN ('direct', 'group')),
  title TEXT NULL,
  last_message_at TIMESTAMPTZ NULL
);

-- Participants: who is in which conversation.
CREATE TABLE IF NOT EXISTS chat_participants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_at TIMESTAMPTZ NULL,
  UNIQUE(conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_participants_conversation ON chat_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_user ON chat_participants(user_id);

-- Messages.
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_name TEXT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);

-- Optional: link shared listing to a message (for "share ad" in chat).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS listing_id UUID NULL;

-- Trigger to update updated_at and last_message_at
CREATE OR REPLACE FUNCTION chat_conversations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION chat_new_message_notify()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_conversations_updated_at ON chat_conversations;
CREATE TRIGGER chat_conversations_updated_at
  BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION chat_conversations_updated_at();

DROP TRIGGER IF EXISTS chat_new_message_notify ON chat_messages;
CREATE TRIGGER chat_new_message_notify
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_new_message_notify();
