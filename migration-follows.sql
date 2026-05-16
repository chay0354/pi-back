-- Follow system: pending requests + accepted follows.

CREATE TABLE IF NOT EXISTS user_follows (
  follower_subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  following_subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_subscription_id, following_subscription_id),
  CONSTRAINT chk_user_follows_not_self CHECK (follower_subscription_id <> following_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_following
  ON user_follows(following_subscription_id);

CREATE TABLE IF NOT EXISTS user_follow_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  target_subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_follow_request_pair UNIQUE (requester_subscription_id, target_subscription_id),
  CONSTRAINT chk_user_follow_requests_not_self CHECK (requester_subscription_id <> target_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follow_requests_target_status
  ON user_follow_requests(target_subscription_id, status);

CREATE INDEX IF NOT EXISTS idx_user_follow_requests_requester_status
  ON user_follow_requests(requester_subscription_id, status);
