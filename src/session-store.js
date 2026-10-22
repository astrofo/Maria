const session = require("express-session");
class DatabaseSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.cleanupAt = 0;
  }
  get(sid, callback) {
    this.db
      .query("SELECT data FROM sessions WHERE sid=$1 AND expires_at>NOW()", [
        sid,
      ])
      .then((r) => callback(null, r.rows[0]?.data || null), callback);
  }
  set(sid, data, callback = () => {}) {
    const expiry = data.cookie.expires || new Date(Date.now() + 8 * 3600000);
    this.db
      .query(
        "INSERT INTO sessions(sid,data,expires_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(sid) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at",
        [sid, JSON.stringify(data), expiry],
      )
      .then(() => callback(), callback);
    if (Date.now() > this.cleanupAt) {
      this.cleanupAt = Date.now() + 3600000;
      this.db
        .query("DELETE FROM sessions WHERE expires_at<NOW()")
        .catch(() => {});
    }
  }
  touch(sid, data, callback = () => {}) {
    this.db
      .query(
        "UPDATE sessions SET expires_at=$1 WHERE sid=$2 AND expires_at < $1::timestamptz - INTERVAL '1 minute'",
        [data.cookie.expires || new Date(Date.now() + 8 * 3600000), sid],
      )
      .then(() => callback(), callback);
  }
  destroy(sid, callback = () => {}) {
    this.db
      .query("DELETE FROM sessions WHERE sid=$1", [sid])
      .then(() => callback(), callback);
  }
}
module.exports = { DatabaseSessionStore };
