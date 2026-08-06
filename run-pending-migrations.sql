-- Pending migrations bundle for project opxeruasowoaybceskyp
-- Safe to re-run (IF NOT EXISTS). Run via Supabase SQL Editor or scripts/run-pending-migrations.js

-- migration-stories-general-details.sql
ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS general_details JSONB;

COMMENT ON COLUMN stories.general_details IS
  'Optional post_text_overlays payload for live text on story media (mainly video).';

-- migration-stories-24h-expiry.sql
CREATE INDEX IF NOT EXISTS stories_created_at_idx ON stories (created_at DESC);

COMMENT ON TABLE stories IS
  'Ephemeral story slides (24h TTL). Feed hides rows older than 24h; hard-delete after 7d so profile mirrors are not resurrected.';

-- Soft expiry is enforced in the API feed (24h). Keep a short history so the
-- same profile video_url cannot open another story window after expiry.
DELETE FROM stories
WHERE created_at < NOW() - INTERVAL '7 days';

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

-- migration-subscriptions-apple-user-id.sql
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS apple_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_apple_user_id_uidx
  ON public.subscriptions (apple_user_id)
  WHERE apple_user_id IS NOT NULL;

COMMENT ON COLUMN public.subscriptions.apple_user_id IS
  'Stable Apple Sign In subject (sub) for re-login when email is omitted.';

-- migration-chat-professional-notification.sql
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_professional_notification BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN chat_messages.is_professional_notification IS
  'True for system-sent "עדכונים על פוסטים רלוונטים" post notifications to matching professionals; enables the in-bubble contact-poster button. False for normal shares/messages.';

-- migration-subscription-block-relevant-post-updates.sql
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS block_relevant_post_updates BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN subscriptions.block_relevant_post_updates IS
  'When true, the professional will not receive system chat notifications about new posts tagged for their profession type.';

-- migration-chat-group-kind.sql
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS group_kind TEXT NULL;

COMMENT ON COLUMN chat_conversations.group_kind IS
  'Group member policy: brokers (broker-only), customers (regular users only), open (any subscription type).';

-- migration-project-marketer.sql (משווק פרויקטים + agency teams)
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.subscriptions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%subscription_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.subscriptions DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_subscription_type_check
  CHECK (subscription_type IN ('user', 'broker', 'company', 'professional', 'project_marketer'));

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.ads'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%subscription_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ads DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.ads
  ADD CONSTRAINT ads_subscription_type_check
  CHECK (subscription_type IS NULL OR subscription_type IN ('user', 'broker', 'company', 'professional', 'project_marketer'));

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS marketer_plan TEXT NULL;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS marketer_seat_limit INTEGER NULL;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS parent_subscription_id UUID NULL REFERENCES public.subscriptions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.subscriptions.marketer_plan IS
  'project_marketer plan: single | team5 | team10. Null for other subscription types.';

COMMENT ON COLUMN public.subscriptions.marketer_seat_limit IS
  'Max team members a marketing manager may onboard via join code (5 or 10). Null = solo marketer.';

COMMENT ON COLUMN public.subscriptions.parent_subscription_id IS
  'Marketing agency manager this subscription belongs to (joined with an invite code).';

CREATE INDEX IF NOT EXISTS subscriptions_parent_subscription_id_idx
  ON public.subscriptions (parent_subscription_id)
  WHERE parent_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.agency_join_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  manager_subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agency_join_codes_manager_idx
  ON public.agency_join_codes (manager_subscription_id);

COMMENT ON TABLE public.agency_join_codes IS
  'Invite codes a project-marketing manager generates so marketers can join the agency.';

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
