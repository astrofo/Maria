-- Keep applications, participation and course progress when content is removed.
ALTER TABLE opportunities
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN archived_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE courses
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN archived_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX opportunities_active_start_idx ON opportunities(starts_at,id)
  WHERE archived_at IS NULL;
CREATE INDEX opportunities_archive_idx ON opportunities(archived_at DESC,id DESC)
  WHERE archived_at IS NOT NULL;
CREATE INDEX courses_active_idx ON courses(id DESC)
  WHERE archived_at IS NULL;
CREATE INDEX courses_archive_idx ON courses(archived_at DESC,id DESC)
  WHERE archived_at IS NOT NULL;
