-- Distinguish "share post to chat" UI from plain messages that only carry listing_id for inbox badges.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_listing_share BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN chat_messages.is_listing_share IS 'True when user shared a feed listing/post card; false for normal text even if listing_id is set';
