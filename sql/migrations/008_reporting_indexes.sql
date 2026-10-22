CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_user_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS participation_date_idx ON participation(participated_on);
CREATE INDEX IF NOT EXISTS users_volunteer_created_idx ON users(created_at) WHERE role='volunteer';
