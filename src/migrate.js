require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { database } = require("./db");
async function migrate(db = database) {
  await db.ready;
  await db.transaction(async (tx) => {
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    const files = [
      ["001_initial.sql", path.join(__dirname, "../sql/schema.sql")],
      ...fs
        .readdirSync(path.join(__dirname, "../sql/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort()
        .map((n) => [n, path.join(__dirname, "../sql/migrations", n)]),
    ];
    for (const [name, filename] of files) {
      const { rows } = await tx.query(
        "SELECT name FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (rows.length) continue;
      await tx.exec(fs.readFileSync(filename, "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}
if (require.main === module)
  migrate()
    .then(() => console.log("Database migrations applied"))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => database.close());
module.exports = { migrate };
