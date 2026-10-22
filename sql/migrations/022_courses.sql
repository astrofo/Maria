-- Courses coexist with the original training_materials and completions.
CREATE TABLE courses (
  id BIGSERIAL PRIMARY KEY,
  document JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX courses_status_id_idx ON courses(status,id);
CREATE TABLE course_enrollments (
  course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_lesson_id TEXT,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(course_id,user_id)
);
CREATE INDEX course_enrollments_user_idx ON course_enrollments(user_id,updated_at DESC);
CREATE TABLE course_lesson_progress (
  course_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  lesson_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  active_attempt UUID,
  attempt_started_at TIMESTAMPTZ,
  last_attempt UUID,
  last_result JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(course_id,user_id,lesson_id),
  FOREIGN KEY(course_id,user_id) REFERENCES course_enrollments(course_id,user_id) ON DELETE CASCADE
);
