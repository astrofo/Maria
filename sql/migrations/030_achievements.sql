CREATE TABLE achievements (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,79}$'),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 120),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  rarity TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
  icon TEXT NOT NULL CHECK (icon IN ('spark','book','people','hands','heart')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

CREATE TABLE user_achievements (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE RESTRICT,
  awarded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  revoked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL)
);
CREATE UNIQUE INDEX user_achievements_active_unique_idx
  ON user_achievements(user_id,achievement_id) WHERE revoked_at IS NULL;
CREATE INDEX user_achievements_recent_idx ON user_achievements(user_id,awarded_at DESC,id DESC);

INSERT INTO achievements(slug,title,description,rarity,icon,sort_order) VALUES
  ('first_event','Первое доброе дело','Участие в первом волонтёрском мероприятии.','common','spark',10),
  ('first_training','Готов помогать','Завершение вводного курса для волонтёров.','uncommon','book',20),
  ('team_player','Часть команды','Участие в пяти волонтёрских мероприятиях.','rare','people',30),
  ('helping_hands','Надёжные руки','Двадцать часов волонтёрской помощи.','epic','hands',40),
  ('heart_of_team','Сердце команды','Пятьдесят часов волонтёрской помощи.','legendary','heart',50);

-- These badges record an administrator's decision, not an automatic threshold.
-- Preserve old notification/ledger history without converting it into awards.
DROP TRIGGER participation_achievement_changed ON participation;
DROP TRIGGER user_achievement_eligibility_changed ON users;
DROP FUNCTION queue_participation_achievement();
DROP FUNCTION queue_user_achievement();
-- Keep the empty queue for rollback compatibility with older application releases.
-- Remove it after those releases have been retired.
DELETE FROM achievement_recheck_queue;
