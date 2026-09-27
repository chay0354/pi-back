-- Enable Supabase Realtime for chat_participants.last_read_at
-- so outgoing messages can turn blue ticks when the peer opens the thread.
-- Safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_participants;
  END IF;
END $$;

ALTER TABLE public.chat_participants REPLICA IDENTITY FULL;
