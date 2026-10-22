const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = "pglite";
process.env.DATABASE_PATH = "memory://";
const { database, createDatabase } = require("../src/db");
const { migrate } = require("../src/migrate");

test("Existing records survive migrations and local database restart", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "deti-marii-storage-"),
  );
  const env = {
    NODE_ENV: "test",
    DATABASE_MODE: "pglite",
    DATABASE_PATH: directory,
  };
  let db = createDatabase(env);
  t.after(async () => {
    await db.close();
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await db.ready;
  // Emulate the earlier unversioned prototype: applying its initial schema and data first.
  await db.exec(
    await fs.readFile(path.join(__dirname, "../sql/schema.sql"), "utf8"),
  );
  const { rows } = await db.query(
    "INSERT INTO users(full_name,email,password_hash) VALUES('Existing volunteer','existing@example.test','unused-test-hash') RETURNING id",
  );
  const id = rows[0].id;
  await migrate(db);
  await migrate(db);
  await db.close();
  db = createDatabase(env);
  await db.ready;
  await migrate(db);
  assert.equal(
    (await db.query("SELECT full_name FROM users WHERE id=$1", [id])).rows[0]
      .full_name,
    "Existing volunteer",
  );
  assert.equal(
    Number(
      (await db.query("SELECT COUNT(*) AS count FROM schema_migrations"))
        .rows[0].count,
    ),
    1 +
      (await fs.readdir(path.join(__dirname, "../sql/migrations"))).filter(
        (name) => name.endsWith(".sql"),
      ).length,
  );
  assert.ok(
    (await db.query("SELECT to_regclass('notifications') AS name")).rows[0]
      .name,
  );
});

test("Embedded database is refused in production", () => {
  assert.throws(
    () => createDatabase({ NODE_ENV: "production", DATABASE_MODE: "pglite" }),
    /Production requires PostgreSQL/,
  );
});
