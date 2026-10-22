-- Index creation can take longer than ordinary API statements on existing data.
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS applications_event_status_created_idx
  ON applications(opportunity_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_user_created_idx
  ON applications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_created_idx
  ON applications(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS applications_status_created_idx
  ON applications(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS opportunities_list_start_idx
  ON opportunities(starts_at ASC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS opportunities_status_start_idx
  ON opportunities(status, starts_at ASC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS participation_user_date_idx
  ON participation(user_id, participated_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS participation_date_id_idx
  ON participation(participated_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS invitations_event_created_idx
  ON opportunity_invitations(opportunity_id, created_at, id);
CREATE INDEX IF NOT EXISTS users_role_created_idx
  ON users(role, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS users_created_idx
  ON users(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS staff_notes_user_created_idx
  ON staff_notes(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS thanks_user_created_idx
  ON thanks(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS training_list_idx
  ON training_materials(required DESC, id);
