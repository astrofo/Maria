-- Queue metadata and notifications commit together; advancing the cursor never
-- happens separately from delivery. No personal event text is stored in the job.
CREATE TABLE notification_broadcasts (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('volunteers','applicants')),
  cursor_user_id BIGINT NOT NULL DEFAULT 0,
  cutoff_user_id BIGINT NOT NULL,
  delivered BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX notification_broadcasts_pending_idx ON notification_broadcasts(id) WHERE status='pending';
CREATE INDEX users_notification_recipients_idx ON users(id) WHERE role='volunteer' AND status IN ('new','active');
-- The newer owner/date/id index covers every use of the older shorter index.
DROP INDEX IF EXISTS notifications_owner_idx;

CREATE TABLE achievement_recheck_queue (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  check_after TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX achievement_recheck_due_idx ON achievement_recheck_queue(check_after,user_id);

CREATE FUNCTION queue_participation_achievement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO achievement_recheck_queue(user_id) SELECT OLD.user_id FROM users WHERE id=OLD.user_id
      ON CONFLICT(user_id) DO UPDATE SET check_after=LEAST(achievement_recheck_queue.check_after,NOW());
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO achievement_recheck_queue(user_id) VALUES(NEW.user_id)
      ON CONFLICT(user_id) DO UPDATE SET check_after=LEAST(achievement_recheck_queue.check_after,NOW());
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER participation_achievement_changed AFTER INSERT OR UPDATE OR DELETE ON participation
  FOR EACH ROW EXECUTE FUNCTION queue_participation_achievement();

CREATE FUNCTION queue_user_achievement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='volunteer' AND NEW.status<>'closed' AND
    (OLD.role IS DISTINCT FROM NEW.role OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO achievement_recheck_queue(user_id) VALUES(NEW.id)
      ON CONFLICT(user_id) DO UPDATE SET check_after=LEAST(achievement_recheck_queue.check_after,NOW());
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER user_achievement_eligibility_changed AFTER UPDATE OF role,status ON users
  FOR EACH ROW EXECUTE FUNCTION queue_user_achievement();

INSERT INTO achievement_recheck_queue(user_id)
  SELECT DISTINCT p.user_id FROM participation p JOIN users u ON u.id=p.user_id
  WHERE u.role='volunteer' AND u.status<>'closed' ON CONFLICT DO NOTHING;
