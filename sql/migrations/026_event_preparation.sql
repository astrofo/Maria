ALTER TABLE opportunities
  ADD COLUMN coordinator_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN required_course_id BIGINT REFERENCES courses(id) ON DELETE SET NULL,
  ADD COLUMN application_deadline TIMESTAMPTZ,
  ADD COLUMN preparation TEXT;

CREATE INDEX opportunities_coordinator_idx ON opportunities(coordinator_id)
  WHERE coordinator_id IS NOT NULL;
CREATE INDEX opportunities_required_course_idx ON opportunities(required_course_id)
  WHERE required_course_id IS NOT NULL;
