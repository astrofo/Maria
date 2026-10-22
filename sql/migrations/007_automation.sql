-- A ledger entry and its notification are committed in the same transaction.
-- Keep the key even when a notification is removed, so it is never recreated.
CREATE TABLE IF NOT EXISTS automation_ledger (
  event_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event_reminder','task_due','achievement')),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_ledger_user_idx
  ON automation_ledger(user_id, created_at DESC);

-- Only operational metadata belongs here: no exception messages or user data.
CREATE TABLE IF NOT EXISTS automation_state (
  name TEXT PRIMARY KEY CHECK (name = 'main'),
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_code TEXT CHECK (last_failure_code IN (
    'database_unavailable','database_busy','automation_failed'
  )),
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  last_counts JSONB NOT NULL DEFAULT '{}'
);
INSERT INTO automation_state(name) VALUES('main') ON CONFLICT(name) DO NOTHING;

CREATE INDEX IF NOT EXISTS opportunities_automation_start_idx
  ON opportunities(starts_at, id) WHERE status='open' AND starts_at IS NOT NULL;
