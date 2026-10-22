const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("pg");

process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = process.env.TEST_DATABASE_URL
  ? "postgres"
  : "pglite";
process.env.DATABASE_PATH = "memory://";
if (process.env.TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");

test(
  "System group messages retain cursor order across PostgreSQL transactions",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires independent PostgreSQL connections; PGlite serializes transactions",
  },
  async (t) => {
    await migrate(database);
    const suffix = crypto.randomBytes(6).toString("hex");
    const lockKey = crypto.randomInt(1, 2147483647);
    const functionName = `security_group_delay_${suffix}`;
    const firstKey = `security-first:${suffix}`;
    const secondKey = `security-second:${suffix}`;
    const eventId = (
      await database.query(
        "INSERT INTO opportunities(title,description) VALUES('Concurrent group fixture','Local regression') RETURNING id",
      )
    ).rows[0].id;
    const blocker = new Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await blocker.connect();
    let first, second;
    t.after(async () => {
      // Release the deliberate pause even when an assertion fails, then remove
      // fixture-only SQL before another suite uses the same test database.
      await blocker.query("ROLLBACK");
      await Promise.allSettled([first, second].filter(Boolean));
      await blocker.end();
      await database.exec(
        `DROP TRIGGER IF EXISTS ${functionName} ON group_messages; DROP FUNCTION IF EXISTS ${functionName}()`,
      );
      await database.query("DELETE FROM opportunities WHERE id=$1", [eventId]);
      await database.close();
    });
    await database.exec(`CREATE FUNCTION ${functionName}() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(91092,${lockKey}); RETURN NEW; END; $$;
    CREATE TRIGGER ${functionName} BEFORE INSERT ON group_messages
      FOR EACH ROW WHEN (NEW.source_key='${firstKey}') EXECUTE FUNCTION ${functionName}()`);
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(91092,$1)", [lockKey]);

    const waitFor = async (query, values) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if ((await database.query(query, values)).rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("Expected concurrent transaction did not reach its lock");
    };
    first = database.transaction((tx) =>
      tx.query("SELECT append_group_system_message($1,$2,'First') AS id", [
        eventId,
        firstKey,
      ]),
    );
    first.catch(() => {});
    // The first insert has allocated its ID but is paused before becoming visible.
    await waitFor(
      "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=91092 AND objid=$1 AND NOT granted",
      [lockKey],
    );
    let resolveSecondPid;
    const secondPid = new Promise((resolve) => {
      resolveSecondPid = resolve;
    });
    let secondCommitted = false;
    second = database
      .transaction(async (tx) => {
        resolveSecondPid(
          (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        return tx.query(
          "SELECT append_group_system_message($1,$2,'Second') AS id",
          [eventId, secondKey],
        );
      })
      .then((value) => {
        secondCommitted = true;
        return value;
      });
    second.catch(() => {});
    const pid = await secondPid;
    await waitFor("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid]);
    assert.equal(
      secondCommitted,
      false,
      "A later message must wait for the earlier message's transaction",
    );
    assert.equal(
      (
        await database.query(
          "SELECT id FROM group_messages WHERE source_key=ANY($1::text[])",
          [[firstKey, secondKey]],
        )
      ).rows.length,
      0,
    );
    await blocker.query("COMMIT");
    const [a, b] = await Promise.all([first, second]);
    assert.ok(BigInt(a.rows[0].id) < BigInt(b.rows[0].id));
    const visible = await database.query(
      "SELECT id,source_key FROM group_messages WHERE source_key=ANY($1::text[]) ORDER BY id",
      [[firstKey, secondKey]],
    );
    assert.deepEqual(
      visible.rows.map((row) => row.source_key),
      [firstKey, secondKey],
    );
    const retried = await database.query(
      "SELECT append_group_system_message($1,$2,'Second') AS id",
      [eventId, secondKey],
    );
    assert.equal(String(retried.rows[0].id), String(b.rows[0].id));
  },
);
