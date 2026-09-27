-- Guest BnB publish flow: lock a newly registered regular user to the
-- host type they chose (private | business) when they created the account.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS bnb_host_lock TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.subscriptions'::regclass
      AND conname = 'subscriptions_bnb_host_lock_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_bnb_host_lock_check
      CHECK (bnb_host_lock IS NULL OR bnb_host_lock IN ('private', 'business'));
  END IF;
END $$;

COMMENT ON COLUMN subscriptions.bnb_host_lock IS
  'Set only when a guest created this regular account from the BnB publish sheet (private or business). Null = both create options remain available.';
