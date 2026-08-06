-- משווק פרויקטים (project marketer) subscription type + agency teams.
-- Safe to re-run.

-- 1) Allow the new subscription type on subscriptions + ads.
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

-- 2) Marketer plan + team hierarchy.
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

-- 3) Agency invite codes issued by a marketing manager.
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

NOTIFY pgrst, 'reload schema';
