CREATE TABLE chat_threads (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  guest_session_hash TEXT UNIQUE,
  guest_name TEXT,
  guest_email TEXT,
  opportunity_id BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  owner_read_id BIGINT NOT NULL DEFAULT 0,
  staff_read_id BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((owner_user_id IS NOT NULL AND guest_session_hash IS NULL)
    OR (owner_user_id IS NULL AND guest_session_hash IS NOT NULL AND guest_email IS NOT NULL))
);
CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('member','guest','organizer')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(thread_id,client_id)
);
CREATE INDEX chat_messages_history_idx ON chat_messages(thread_id,id DESC);
CREATE INDEX chat_threads_recent_idx ON chat_threads(updated_at DESC,id DESC);

CREATE TABLE message_campaigns (
  id BIGSERIAL PRIMARY KEY,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  sent_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT '' CHECK (length(title)<=160),
  body TEXT NOT NULL DEFAULT '' CHECK (length(body)<=4000),
  kind TEXT NOT NULL DEFAULT 'groups' CHECK (kind IN ('groups','event')),
  roles TEXT[] NOT NULL DEFAULT '{volunteer}',
  opportunity_id BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  action_label TEXT NOT NULL DEFAULT '' CHECK (length(action_label)<=60),
  target_type TEXT CHECK (target_type IN ('opportunities','training','dashboard','questionnaire','event')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','sending','sent','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  review_hash TEXT,
  review_expires_at TIMESTAMPTZ,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE(created_by,client_id)
);
CREATE TABLE campaign_recipients (
  campaign_id BIGINT NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','skipped')),
  PRIMARY KEY(campaign_id,user_id)
);
CREATE INDEX campaigns_recent_idx ON message_campaigns(updated_at DESC,id DESC);
CREATE INDEX campaigns_queue_idx ON message_campaigns(id) WHERE status IN ('queued','sending');
CREATE INDEX campaign_pending_idx ON campaign_recipients(campaign_id,user_id) WHERE status='pending';

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_type TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_id BIGINT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_label TEXT;
