-- Email keys and browser sessions are HMACs. Delivery secrets are AES-GCM
-- encrypted, independent of the HMAC used to verify the four-digit code.
CREATE TABLE pending_login_codes (
  email_hash TEXT PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  auth_version INTEGER,
  login_session_hash TEXT NOT NULL,
  code_hash TEXT,
  code_nonce TEXT,
  code_ciphertext TEXT,
  expires_at TIMESTAMPTZ,
  send_status TEXT NOT NULL DEFAULT 'failed'
    CHECK (send_status IN ('queued','sending','sent','failed','consumed')),
  delivery_claim TEXT,
  delivery_started_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  rate_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count BETWEEN 0 AND 5),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  day_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  day_failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (day_failed_attempts BETWEEN 0 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX pending_login_codes_queued_idx
  ON pending_login_codes(last_sent_at,email_hash) WHERE send_status='queued';
CREATE INDEX pending_login_codes_updated_idx ON pending_login_codes(updated_at);
