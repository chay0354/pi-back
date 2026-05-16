-- Group ownership and roles for Pi Chat (run in Supabase SQL Editor).
-- Enables promote/remove/leave with correct permissions.

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS group_creator_email TEXT NULL;

COMMENT ON COLUMN chat_conversations.group_creator_email IS 'Email of the broker who created the group; used for ownership when participant.group_role is missing.';

ALTER TABLE chat_participants
  ADD COLUMN IF NOT EXISTS group_role TEXT DEFAULT 'member';

COMMENT ON COLUMN chat_participants.group_role IS 'owner | manager | member';

-- Backfill creator from earliest join per group (approximates historical creators).
UPDATE chat_conversations c
SET group_creator_email = sub.uid
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    lower(trim(user_id::text)) AS uid
  FROM chat_participants
  ORDER BY conversation_id, joined_at ASC NULLS LAST
) sub
WHERE c.id = sub.conversation_id
  AND c.type = 'group'
  AND (c.group_creator_email IS NULL OR trim(c.group_creator_email) = '');

-- Mark owners where creator email matches participant user_id (email stored lowercase).
UPDATE chat_participants cp
SET group_role = 'owner'
FROM chat_conversations c
WHERE cp.conversation_id = c.id
  AND c.type = 'group'
  AND c.group_creator_email IS NOT NULL
  AND trim(c.group_creator_email) <> ''
  AND lower(trim(cp.user_id::text)) = lower(trim(c.group_creator_email::text));

-- Ensure at least one owner per group: if none, promote earliest joiner.
WITH ranked AS (
  SELECT
    cp.id,
    cp.conversation_id,
    ROW_NUMBER() OVER (PARTITION BY cp.conversation_id ORDER BY cp.joined_at ASC NULLS LAST) AS rn
  FROM chat_participants cp
  JOIN chat_conversations c ON c.id = cp.conversation_id AND c.type = 'group'
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_participants x
    WHERE x.conversation_id = cp.conversation_id AND x.group_role = 'owner'
  )
)
UPDATE chat_participants cp
SET group_role = 'owner'
FROM ranked r
WHERE cp.id = r.id AND r.rn = 1;

UPDATE chat_conversations c
SET group_creator_email = lower(trim(cp.user_id::text))
FROM chat_participants cp
WHERE cp.conversation_id = c.id
  AND c.type = 'group'
  AND cp.group_role = 'owner'
  AND (c.group_creator_email IS NULL OR trim(c.group_creator_email) = '');
