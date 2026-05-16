-- Improvement feedback table (suggestions screen).
-- Keeps all feedback data and who submitted it.

CREATE TABLE IF NOT EXISTS improvements_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  improvement_text TEXT NOT NULL,
  created_by_subscription_id UUID NULL REFERENCES subscriptions(id) ON DELETE SET NULL,
  created_by_email TEXT NULL,
  created_by_name TEXT NULL,
  created_by_subscription_type TEXT NULL,
  created_by_subscriber_number TEXT NULL,
  source_screen TEXT NOT NULL DEFAULT 'feedbackSuggestion',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_improvements_feedback_created_at
  ON improvements_feedback(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_improvements_feedback_created_by_subscription_id
  ON improvements_feedback(created_by_subscription_id);

CREATE INDEX IF NOT EXISTS idx_improvements_feedback_created_by_email
  ON improvements_feedback(created_by_email);
