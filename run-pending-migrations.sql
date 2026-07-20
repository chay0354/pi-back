-- Pending migrations bundle for project opxeruasowoaybceskyp
-- Safe to re-run (IF NOT EXISTS). Run via Supabase SQL Editor or scripts/run-pending-migrations.js

-- migration-stories-general-details.sql
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS general_details JSONB;

COMMENT ON COLUMN stories.general_details IS
  'Optional post_text_overlays payload for live text on story media (mainly video).';

-- migration-chat-exclusive-offer-kind.sql
ALTER TABLE chat_exclusive_offers
  ADD COLUMN IF NOT EXISTS offer_kind TEXT DEFAULT 'exclusive';

COMMENT ON COLUMN chat_exclusive_offers.offer_kind IS
  'exclusive (בלעדיות) or collab (שת״פ). Same accept/reject workflow.';

-- migration-subscription-block-offers.sql
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_exclusive_offers BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_collab_offers BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN subscriptions.block_exclusive_offers IS
  'When true, other users cannot send exclusivity (בלעדיות) offers in direct chat.';

COMMENT ON COLUMN subscriptions.block_collab_offers IS
  'When true, other brokers cannot send collaboration (שת״פ) offers in direct chat.';

-- migration-chat-group-image.sql
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_image_url TEXT NULL;

-- migration-chat-group-description.sql
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_description TEXT NULL;

-- migration-chat-messages-realtime.sql (fixes ChatScreen CHANNEL_ERROR)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
END $$;

ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
