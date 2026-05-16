-- Exclusive-offer workflow for Pi Chat (direct threads). Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS chat_exclusive_offers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  listing_id UUID NULL REFERENCES ads(id) ON DELETE SET NULL,
  broker_email TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  months_committed INT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_exclusive_offers_conversation ON chat_exclusive_offers(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_exclusive_offers_listing ON chat_exclusive_offers(listing_id);
