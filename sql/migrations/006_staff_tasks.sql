CREATE TABLE IF NOT EXISTS staff_tasks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  due_at TIMESTAMPTZ CHECK (due_at IS NULL OR isfinite(due_at)),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  completed_at TIMESTAMPTZ CHECK (completed_at IS NULL OR isfinite(completed_at)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_tasks_completion_matches_status
    CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS staff_tasks_status_due_idx ON staff_tasks(status, due_at, id);
CREATE INDEX IF NOT EXISTS staff_tasks_assignee_idx ON staff_tasks(assigned_to, status, due_at, id);
CREATE INDEX IF NOT EXISTS staff_tasks_creator_idx ON staff_tasks(created_by, id DESC);
CREATE INDEX IF NOT EXISTS staff_tasks_volunteer_idx ON staff_tasks(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS staff_tasks_pending_deadline_idx ON staff_tasks(due_at, id)
  WHERE status IN ('open', 'in_progress') AND due_at IS NOT NULL;
