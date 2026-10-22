-- Older accounts keep working; verified registration applies to new signups.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'unspecified'
  CHECK (gender IN ('female','male','unspecified'));

-- Pending signups have no user account or application permissions.
CREATE TABLE IF NOT EXISTS pending_email_registrations (
  email TEXT PRIMARY KEY,
  profile JSONB NOT NULL,
  password_hash TEXT NOT NULL,
  registration_session_hash TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_accepted_at TIMESTAMPTZ NOT NULL,
  code_hash TEXT,
  code_nonce TEXT,
  expires_at TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  send_status TEXT NOT NULL DEFAULT 'failed' CHECK (send_status IN ('sending','sent','failed')),
  last_sent_at TIMESTAMPTZ,
  rate_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_email_registrations_updated_idx
  ON pending_email_registrations(updated_at);
