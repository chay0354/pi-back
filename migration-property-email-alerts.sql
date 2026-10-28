-- Broker email alerts for newly published properties, by category.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS property_email_alerts BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS property_alert_categories JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN subscriptions.property_email_alerts IS
  'When true, email this broker each time a property is published in one of property_alert_categories.';

COMMENT ON COLUMN subscriptions.property_alert_categories IS
  'JSON array of feed category ids (1, 2, 3, 4, 5, 6, 7, 8, 10, 12) the broker wants emailed.';

NOTIFY pgrst, 'reload schema';
