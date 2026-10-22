CREATE TABLE password_reset_requests (
  email_hash TEXT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  send_count INTEGER NOT NULL DEFAULT 1
);
