-- Professionals can opt out of "עדכונים על פוסטים רלוונטים" system chat notifications.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_relevant_post_updates BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN subscriptions.block_relevant_post_updates IS
  'When true, the professional will not receive system chat notifications about new posts tagged for their profession type.';
