-- Per-user chat offer blocking preferences.
-- Regular users: block_exclusive_offers blocks broker exclusivity offers.
-- Brokers: block_collab_offers blocks broker↔broker collaboration offers.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_exclusive_offers BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_collab_offers BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN subscriptions.block_exclusive_offers IS
  'When true, other users cannot send exclusivity (בלעדיות) offers in direct chat.';

COMMENT ON COLUMN subscriptions.block_collab_offers IS
  'When true, other brokers cannot send collaboration (שת״פ) offers in direct chat.';
