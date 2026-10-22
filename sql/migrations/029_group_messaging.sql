CREATE TABLE group_threads (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','direct')),
  user_low_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  user_high_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind='event' AND user_low_id IS NULL AND user_high_id IS NULL)
    OR (kind='direct' AND user_low_id IS NOT NULL AND user_high_id IS NOT NULL AND user_low_id<user_high_id))
);
CREATE UNIQUE INDEX group_event_unique_idx ON group_threads(opportunity_id) WHERE kind='event';
CREATE UNIQUE INDEX group_direct_unique_idx ON group_threads(opportunity_id,user_low_id,user_high_id) WHERE kind='direct';
CREATE INDEX group_threads_recent_idx ON group_threads(updated_at DESC,id DESC);
CREATE INDEX group_direct_low_idx ON group_threads(user_low_id) WHERE kind='direct';
CREATE INDEX group_direct_high_idx ON group_threads(user_high_id) WHERE kind='direct';

CREATE TABLE group_messages (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES group_threads(id) ON DELETE CASCADE,
  sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','announcement','system')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  client_id UUID,
  source_key TEXT CHECK (length(source_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind='system' AND client_id IS NULL AND source_key IS NOT NULL AND sender_user_id IS NULL)
    OR (kind<>'system' AND client_id IS NOT NULL AND source_key IS NULL)),
  UNIQUE(group_id,client_id),
  UNIQUE(group_id,source_key)
);
CREATE INDEX group_messages_history_idx ON group_messages(group_id,id DESC);
CREATE INDEX group_messages_sender_rate_idx ON group_messages(sender_user_id,created_at DESC)
  WHERE sender_user_id IS NOT NULL;
CREATE TABLE group_reads (
  group_id BIGINT NOT NULL REFERENCES group_threads(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id BIGINT NOT NULL DEFAULT 0 CHECK (last_read_id>=0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(group_id,user_id)
);

-- Membership is derived from current roles, invitations and accepted applications.
-- Creating the thread here also covers imports and events created outside HTTP.
CREATE FUNCTION ensure_event_group() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO group_threads(opportunity_id,kind) VALUES(NEW.id,'event') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_group_created AFTER INSERT ON opportunities
  FOR EACH ROW EXECUTE FUNCTION ensure_event_group();
INSERT INTO group_threads(opportunity_id,kind) SELECT id,'event' FROM opportunities ON CONFLICT DO NOTHING;

-- Retries of reminders and campaign delivery reuse a stable key, never a new UUID.
CREATE FUNCTION append_group_system_message(event_id BIGINT, message_key TEXT, message_body TEXT)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE thread_id BIGINT; message_id BIGINT;
BEGIN
  -- Lock before assigning a message ID: cursors and read receipts assume that
  -- a later ID cannot commit while an earlier message is still uncommitted.
  SELECT id INTO thread_id FROM group_threads WHERE opportunity_id=event_id AND kind='event' FOR UPDATE;
  IF thread_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO group_messages(group_id,kind,body,source_key)
    VALUES(thread_id,'system',message_body,message_key)
    ON CONFLICT(group_id,source_key) DO NOTHING RETURNING id INTO message_id;
  IF message_id IS NOT NULL THEN
    UPDATE group_threads SET updated_at=NOW() WHERE id=thread_id;
  ELSE
    SELECT id INTO message_id FROM group_messages WHERE group_id=thread_id AND source_key=message_key;
  END IF;
  RETURN message_id;
END;
$$;

CREATE FUNCTION announce_event_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE changes TEXT[] := '{}';
BEGIN
  IF OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at THEN
    changes := array_append(changes,'дата или время');
  END IF;
  IF OLD.location IS DISTINCT FROM NEW.location OR OLD.city IS DISTINCT FROM NEW.city THEN
    changes := array_append(changes,'место проведения');
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN changes := array_append(changes,'статус мероприятия'); END IF;
  IF OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN changes := array_append(changes,'доступность мероприятия'); END IF;
  IF OLD.preparation IS DISTINCT FROM NEW.preparation OR OLD.required_course_id IS DISTINCT FROM NEW.required_course_id THEN
    changes := array_append(changes,'подготовка к участию');
  END IF;
  IF cardinality(changes)>0 THEN
    PERFORM append_group_system_message(NEW.id,
      'event-change:'||txid_current()::text||':'||md5(to_jsonb(OLD)::text||to_jsonb(NEW)::text),
      'Обновлены '||array_to_string(changes,', ')||'. Откройте карточку мероприятия, чтобы посмотреть актуальные условия.');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_group_changed AFTER UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION announce_event_change();

CREATE FUNCTION announce_event_campaign() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft' AND NEW.status='queued' AND NEW.kind='event' AND NEW.opportunity_id IS NOT NULL THEN
    PERFORM append_group_system_message(NEW.opportunity_id,'campaign:'||NEW.id::text,
      NEW.title||E'\n\n'||NEW.body);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_campaign_group_message AFTER UPDATE ON message_campaigns
  FOR EACH ROW EXECUTE FUNCTION announce_event_campaign();
