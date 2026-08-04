-- Persist group membership policy: brokers | customers (regular-only) | open (all user kinds).
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_kind TEXT NULL;

COMMENT ON COLUMN chat_conversations.group_kind IS
  'Group member policy: brokers (broker-only), customers (regular users only), open (any subscription type).';
