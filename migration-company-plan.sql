-- מנוי לחברות: plan chosen at signup, caps how many listings stay published.
-- Only affects subscription_type = 'company'; project marketers are untouched.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS company_plan TEXT;

COMMENT ON COLUMN subscriptions.company_plan IS
  'Company subscription plan: projects5 (5 listings) | projects10 (10 listings) | multi (unlimited). NULL = legacy/unlimited. Feed posts are never limited.';
