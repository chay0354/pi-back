-- Enable Supabase Realtime for chat_messages.
-- Fixes client CHANNEL_ERROR on postgres_changes subscriptions in ChatScreen.
-- Safe to re-run.

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

-- Needed so UPDATE/DELETE payloads (and filtered INSERT) include full row data.
ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;
