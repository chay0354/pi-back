-- Recent user searches: each row = one user (user_subscription_id) searched another user (target_subscription_id).
-- The אחרונים section of the TikTok feed user-search panel reads from this table, newest first.
-- Run this in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS user_search_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_subscription_id UUID NOT NULL,
  target_subscription_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_search_history_no_self CHECK (
    user_subscription_id <> target_subscription_id
  ),
  CONSTRAINT user_search_history_unique UNIQUE (
    user_subscription_id,
    target_subscription_id
  )
);

CREATE INDEX IF NOT EXISTS idx_user_search_history_by_user_updated
  ON user_search_history (user_subscription_id, updated_at DESC);

COMMENT ON TABLE user_search_history IS
  'Persists each user_subscription_id → target_subscription_id search so the "אחרונים" list can be shown later. ON CONFLICT bumps updated_at to keep the entry fresh.';
