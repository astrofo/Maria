const { Pool, types } = require("pg");

// All embedded queries share one queue so no other request can enter a transaction.
function createDatabase(env = process.env) {
  if (env.DATABASE_MODE === "pglite") {
    if (env.NODE_ENV === "production")
      throw new Error("Production requires PostgreSQL");
    const { PGlite } = require("@electric-sql/pglite");
    const pg = new PGlite(env.DATABASE_PATH || "memory://", {
      parsers: { 1082: (value) => value },
    });
    let tail = Promise.resolve();
    const queue = (fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    };
    const scoped = {
      query: (sql, values = []) => pg.query(sql, values),
      exec: (sql) => pg.exec(sql),
    };
    return {
      ready: pg.waitReady,
      query: (...args) => queue(() => scoped.query(...args)),
      exec: (...args) => queue(() => scoped.exec(...args)),
      transaction: (fn) =>
        queue(async () => {
          await pg.exec("BEGIN");
          try {
            const result = await fn(scoped);
            await pg.exec("COMMIT");
            return result;
          } catch (error) {
            try {
              await pg.exec("ROLLBACK");
            } catch {
              // Preserve the failure that caused the transaction to abort.
            }
            throw error;
          }
        }),
      close: () => queue(() => pg.close()),
    };
  }
  const timeout = (name, fallback, maximum) => {
    const value =
      env[name] === undefined || env[name] === ""
        ? fallback
        : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 100 || value > maximum)
      throw new Error(
        `${name} must be an integer between 100 and ${maximum} milliseconds`,
      );
    return value;
  };
  const pool = new Pool({
    connectionString: env.DATABASE_URL || undefined,
    max: 10,
    connectionTimeoutMillis: timeout("PG_CONNECTION_TIMEOUT_MS", 5000, 60000),
    statement_timeout: timeout("PG_STATEMENT_TIMEOUT_MS", 15000, 300000),
    lock_timeout: timeout("PG_LOCK_TIMEOUT_MS", 5000, 60000),
    idle_in_transaction_session_timeout: timeout(
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      30000,
      300000,
    ),
    host: env.PGHOST,
    port: env.PGPORT ? Number(env.PGPORT) : undefined,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
    // Calendar dates must not shift when a host runs in a different timezone.
    types: {
      getTypeParser: (oid, format) =>
        oid === 1082 ? (value) => value : types.getTypeParser(oid, format),
    },
    ssl: env.PGSSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  pool.on("error", () => console.error("Database connection error"));
  const bounded = (promise) =>
    promise.catch((error) => {
      if (!error.code && /timeout/i.test(error.message || ""))
        error.code = "DB_TIMEOUT";
      throw error;
    });
  return {
    ready: Promise.resolve(),
    query: (sql, values = []) => bounded(pool.query(sql, values)),
    exec: (sql) => bounded(pool.query(sql)),
    transaction: async (fn) => {
      const client = await bounded(pool.connect());
      let broken = null;
      let finished = false;
      let rejectConnection;
      const connectionFailed = new Promise((_, reject) => {
        rejectConnection = reject;
      });
      // An idle transaction may fail while its callback awaits HTTP backpressure,
      // with no active query to receive the driver's error event.
      connectionFailed.catch(() => {});
      const onClientError = (error) => {
        broken ||= error;
        rejectConnection(broken);
      };
      client.on("error", onClientError);
      const query = async (sql, values = []) => {
        if (broken) throw broken;
        if (finished) {
          throw Object.assign(new Error("Transaction is already finished"), {
            code: "TRANSACTION_FINISHED",
          });
        }
        const result = await client.query(sql, values);
        if (broken) throw broken;
        return result;
      };
      try {
        await query("BEGIN");
        const result = await Promise.race([
          Promise.resolve().then(() =>
            fn({ query, exec: (sql) => query(sql) }),
          ),
          connectionFailed,
        ]);
        await query("COMMIT");
        return result;
      } catch (error) {
        if (!broken) {
          try {
            await query("ROLLBACK");
          } catch (rollbackError) {
            broken ||= rollbackError;
          }
        }
        // ROLLBACK may itself fail after a connection loss. It must never replace
        // the original callback/query error; the broken client is discarded below.
        throw error;
      } finally {
        finished = true;
        try {
          // pg-pool reinstalls its idle error handler synchronously in release().
          // Passing the failure removes this connection instead of reusing it.
          client.release(broken || undefined);
        } finally {
          client.removeListener("error", onClientError);
        }
      }
    },
    close: () => pool.end(),
  };
}
const database = createDatabase();
module.exports = {
  database,
  createDatabase,
  query: (...args) => database.query(...args),
  close: () => database.close(),
};
