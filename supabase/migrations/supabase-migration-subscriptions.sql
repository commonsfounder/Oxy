-- User subscription entitlements (server side of record)
-- Status: 'trial' | 'active' | 'past_due' | 'canceled' | 'free'
CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);

-- RLS: users can read their own
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_subscriptions' AND policyname = 'Users can read own subscription'
  ) THEN
    CREATE POLICY "Users can read own subscription" ON user_subscriptions
      FOR SELECT USING (auth.uid()::text = user_id OR current_setting('request.jwt.claims', true)::json->>'user_id' = user_id);
  END IF;
END $$;
