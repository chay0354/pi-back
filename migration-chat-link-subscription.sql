-- Let one subscription see chat conversations of another (e.g. same person, different account).
-- Run in Supabase SQL Editor.
-- Example: UPDATE subscriptions SET linked_chat_subscription_id = '440ff1f1-bc63-40c3-86bc-39b97ffe6c15' WHERE id = '20be5e65-9cf8-4a12-b88f-b6d9d07219ae';

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS linked_chat_subscription_id TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_linked_chat ON subscriptions(linked_chat_subscription_id) WHERE linked_chat_subscription_id IS NOT NULL;
