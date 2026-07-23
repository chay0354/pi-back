-- Stories expire after 24 hours (all kinds: posts, sales images, profile mirrors).
-- App also deletes expired rows on /api/stories/feed and POST /api/stories.
-- Optional: schedule this in Supabase (pg_cron) for cleanup when traffic is low.

CREATE INDEX IF NOT EXISTS stories_created_at_idx ON stories (created_at DESC);

COMMENT ON TABLE stories IS
  'Ephemeral story slides (24h TTL). Feed hides and deletes rows older than 24h.';

-- One-shot cleanup of anything already past 24h
DELETE FROM stories
WHERE created_at < NOW() - INTERVAL '24 hours';

-- Optional cron (requires pg_cron). Uncomment if the extension is enabled:
-- SELECT cron.schedule(
--   'purge-expired-stories',
--   '15 * * * *',
--   $$DELETE FROM stories WHERE created_at < NOW() - INTERVAL '24 hours'$$
-- );
