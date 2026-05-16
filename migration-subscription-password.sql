-- B2B login: store hashed password on subscriptions (company, broker, professional)
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

COMMENT ON COLUMN subscriptions.password_hash IS 'scrypt hash for email+password login (B2B types)';
