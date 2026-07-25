-- Run in Supabase SQL Editor (once) so Apple Sign-In can re-link accounts by Apple sub.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS apple_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_apple_user_id_uidx
  ON public.subscriptions (apple_user_id)
  WHERE apple_user_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
