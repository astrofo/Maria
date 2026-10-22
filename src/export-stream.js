const { verifyPassword } = require("./passwords");
const rateLimit = require("express-rate-limit");
const { randomBytes, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const failure = (status, message) =>
  Object.assign(new Error(message), { status });
const quote = (name) => `"${name}"`;
const TICKET_TTL_MS = 60000;
const EXPORT_TIMEOUT_MS = 15 * 60000;
const OMITTED = [
  "password_hash",
  "auth_version",
  "sessions",
  "pending_email_registrations",
  "pending_login_codes",
  "automation_ledger",
  "automation_state",
  "notification_broadcasts",
  "achievement_recheck_queue",
  "download tickets",
  "SMTP credentials",
  "guest_session_hash",
  "chat/campaign client_id",
  "campaign review_hash",
  "course active_attempt/last_attempt",
];

async function writeChunk(res, data, signal) {
  if (signal.aborted || res.destroyed)
    throw failure(499, "Скачивание отменено.");
  if (!res.write(data)) await once(res, "drain", { signal });
}

async function finishResponse(res, signal) {
  if (signal.aborted || res.destroyed)
    throw failure(499, "Скачивание отменено.");
  const done = once(res, "finish", { signal });
  res.end();
  await done;
}

async function cursorRows(tx, select, consume, signal) {
  // A cursor bounds both Node memory and the size of each pg result. The outer
  // transaction holds one consistent, read-only snapshot for the entire file.
  await tx.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${select}`);
  try {
    while (!signal.aborted) {
      const { rows } = await tx.query("FETCH FORWARD 200 FROM export_rows");
      if (!rows.length) break;
      await consume(rows);
    }
    if (signal.aborted) throw failure(499, "Скачивание отменено.");
  } finally {
    await tx.query("CLOSE export_rows").catch(() => {});
  }
}

async function businessStream(db, res, format, signal, tables, volunteersCsv) {
  await db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    await tx.query("SET LOCAL statement_timeout='30s'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    const { rows: clock } = await tx.query(
      "SELECT CURRENT_TIMESTAMP AS exported_at",
    );
    if (format === "csv") {
      await writeChunk(res, volunteersCsv({ tables: { users: [] } }), signal);
      await cursorRows(
        tx,
        `SELECT ${tables.users.map((name) => `u.${quote(name)}`).join(",")},
        q.payload AS questionnaire_payload,q.completed_at AS questionnaire_completed_at,
        q.updated_at AS questionnaire_updated_at,
        COALESCE(p.total_hours,0) AS total_hours,COALESCE(p.entries,0) AS entries,
        (SELECT COUNT(*) FROM applications a WHERE a.user_id=u.id AND a.status='accepted') AS accepted
        FROM users u LEFT JOIN volunteer_questionnaires q ON q.user_id=u.id
        LEFT JOIN LATERAL (SELECT SUM(hours) AS total_hours,COUNT(*) AS entries
          FROM participation WHERE user_id=u.id) p ON true
        WHERE u.role='volunteer' ORDER BY u.id`,
        async (users) => {
          const questionnaires = users
            .filter((u) => u.questionnaire_payload != null)
            .map((u) => ({
              user_id: u.id,
              payload: u.questionnaire_payload,
              completed_at: u.questionnaire_completed_at,
              updated_at: u.questionnaire_updated_at,
            }));
          const stats = new Map(
            users.map((u) => [
              String(u.id),
              {
                hours: Number(u.total_hours),
                participations: Number(u.entries),
                accepted: Number(u.accepted),
              },
            ]),
          );
          const block = volunteersCsv({
            tables: { users, volunteer_questionnaires: questionnaires },
            stats,
          });
          // The BOM and header were already emitted once, including for an empty DB.
          await writeChunk(res, block.slice(block.indexOf("\r\n") + 2), signal);
        },
        signal,
      );
      return;
    }
    const prefix = JSON.stringify({
      format: "deti-marii-business-export",
      version: 2,
      exported_at: clock[0].exported_at,
      omitted: OMITTED,
    });
    await writeChunk(res, `${prefix.slice(0, -1)},"tables":{`, signal);
    let tableIndex = 0;
    let rowCount = 0;
    for (const [name, columns] of Object.entries(tables)) {
      await writeChunk(
        res,
        `${tableIndex++ ? "," : ""}${JSON.stringify(name)}:[`,
        signal,
      );
      let firstRow = true;
      const order = columns.includes("id")
        ? '"id"'
        : name === "training_completions"
          ? '"user_id","material_id"'
          : '"user_id"';
      await cursorRows(
        tx,
        `SELECT ${columns.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${order}`,
        async (rows) => {
          for (const row of rows) {
            await writeChunk(
              res,
              `${firstRow ? "" : ","}${JSON.stringify(row)}`,
              signal,
            );
            firstRow = false;
            rowCount += 1;
          }
        },
        signal,
      );
      await writeChunk(res, "]", signal);
    }
    await writeChunk(res, `},"row_count":${rowCount}}\n`, signal);
  });
}

async function backupStream(res, signal, postgresEnvironment) {
  if (process.env.DATABASE_MODE === "pglite")
    throw failure(
      409,
      "Для .dump нужен сервер PostgreSQL. В деморежиме доступны JSON и CSV.",
    );
  const child = spawn(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--no-password",
      "--lock-wait-timeout=15s",
      "--exclude-table-data=public.sessions",
      "--exclude-table-data=public.pending_email_registrations",
      "--exclude-table-data=public.pending_login_codes",
    ],
    { env: postgresEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.resume(); // Never expose connection details or database content in diagnostics.
  const result = new Promise((resolve) => {
    child.once("error", () => resolve({ failed: true }));
    child.once("close", (code) => resolve({ failed: code !== 0 }));
  });
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      await writeChunk(res, chunk, signal);
    }
    const outcome = await result;
    if (outcome.failed || !bytes)
      throw failure(
        503,
        "Не удалось выгрузить PostgreSQL. Незавершённый файл нельзя использовать.",
      );
    if (signal.aborted) throw failure(499, "Скачивание отменено.");
    // Caller sends the final HTTP chunk only after pg_dump has exited successfully.
  } finally {
    stop();
    await result;
    signal.removeEventListener("abort", stop);
  }
}

function registerStreamingExports(
  app,
  dependencies,
  { tables, volunteersCsv, postgresEnvironment, requestSchema },
) {
  const { db, auth, requireRole, wrap, audit } = dependencies;
  const writeAudit = (actor, action, format) =>
    audit
      ? audit(db, actor, action, `export_${format}`, actor)
      : db.query(
          "INSERT INTO audit_log(actor_id,action,subject_type,subject_id) VALUES($1,$2,$3,$1)",
          [actor, action, `export_${format}`],
        );
  const limiter = rateLimit({
    windowMs: 60 * 60000,
    limit: 5,
    keyGenerator: (req) => `admin-export:${req.user.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Допускается пять подготовок выгрузки в час. Повторите позже.",
    },
  });
  const tickets = new Map();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  let active = false;
  const verify = async (req) => {
    const input = requestSchema.parse(req.body);
    const { rows } = await db.query(
      "SELECT password_hash,role,status,auth_version FROM users WHERE id=$1",
      [req.user.id],
    );
    const current = rows[0];
    if (
      !current ||
      current.role !== "admin" ||
      current.status === "closed" ||
      current.auth_version !== req.user.auth_version
    )
      throw failure(403, "Недостаточно прав для экспорта.");
    if (
      !(await verifyPassword(input.current_password, current.password_hash))
    ) {
      await writeAudit(
        req.user.id,
        "admin_export_password_rejected",
        input.format,
      );
      throw failure(403, "Неверный пароль администратора.");
    }
    if (active)
      throw failure(409, "Другая выгрузка ещё выполняется. Повторите позже.");
    return input;
  };
  const download = async (req, res, format) => {
    if (active)
      throw failure(409, "Другая выгрузка ещё выполняется. Повторите позже.");
    active = true;
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    const timer = setTimeout(() => {
      controller.abort();
      res.destroy();
    }, EXPORT_TIMEOUT_MS);
    timer.unref();
    res.once("close", disconnect);
    let started = false;
    try {
      // Password hashing yields to other requests. Recheck access after it and
      // again when consuming a ticket, before starting any data transfer.
      const { rows: access } = await db.query(
        "SELECT role,status,auth_version FROM users WHERE id=$1",
        [req.user.id],
      );
      if (
        !access[0] ||
        access[0].role !== "admin" ||
        access[0].status === "closed" ||
        access[0].auth_version !== req.user.auth_version
      )
        throw failure(403, "Права доступа изменились. Выгрузка отменена.");
      await writeAudit(req.user.id, "admin_export_started", format);
      started = true;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.set({
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.attachment(
        `deti-marii-${format === "backup" ? "backup" : "export"}-${stamp}.${format === "backup" ? "dump" : format}`,
      );
      res.type(
        format === "backup"
          ? "application/octet-stream"
          : format === "json"
            ? "application/json; charset=utf-8"
            : "text/csv; charset=utf-8",
      );
      if (format === "backup")
        await backupStream(res, controller.signal, postgresEnvironment);
      else
        await businessStream(
          db,
          res,
          format,
          controller.signal,
          tables,
          volunteersCsv,
        );
      await finishResponse(res, controller.signal);
      await writeAudit(req.user.id, "admin_export_completed", format).catch(
        () => console.error("Export completion audit failed"),
      );
    } catch (cause) {
      controller.abort();
      if (res.headersSent) res.destroy();
      if (started)
        await writeAudit(req.user.id, "admin_export_failed", format).catch(() =>
          console.error("Export failure audit failed"),
        );
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Type");
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      res.removeListener("close", disconnect);
      active = false;
    }
  };
  app.post(
    "/api/admin/exports/prepare",
    auth,
    requireRole("admin"),
    limiter,
    wrap(async (req, res) => {
      const input = await verify(req);
      const now = Date.now();
      for (const [key, ticket] of tickets)
        if (ticket.expires <= now) tickets.delete(key);
      if (tickets.size >= 100)
        throw failure(
          429,
          "Слишком много подготовленных выгрузок. Повторите через минуту.",
        );
      const token = randomBytes(32).toString("hex");
      const expires = now + TICKET_TTL_MS;
      tickets.set(digest(token), {
        user: String(req.user.id),
        session: digest(req.sessionID),
        version: req.user.auth_version,
        format: input.format,
        expires,
      });
      res.set("Cache-Control", "no-store").json({
        download_url: `/api/admin/exports/download/${token}`,
        expires_at: new Date(expires).toISOString(),
      });
    }),
  );
  app.get(
    "/api/admin/exports/download/:token",
    auth,
    requireRole("admin"),
    wrap(async (req, res) => {
      if (req.method !== "GET") return res.status(405).end();
      const token = req.params.token;
      if (!/^[a-f0-9]{64}$/.test(token))
        throw failure(404, "Ссылка недействительна.");
      const key = digest(token);
      const ticket = tickets.get(key);
      if (
        !ticket ||
        ticket.expires <= Date.now() ||
        ticket.user !== String(req.user.id) ||
        ticket.session !== digest(req.sessionID) ||
        ticket.version !== req.user.auth_version
      )
        throw failure(
          410,
          "Ссылка истекла или уже использована. Подготовьте выгрузку заново.",
        );
      if (active)
        throw failure(409, "Другая выгрузка ещё выполняется. Повторите позже.");
      tickets.delete(key);
      await download(req, res, ticket.format);
    }),
  );
  // Existing integrations can continue to download directly through authenticated POST.
  app.post(
    "/api/admin/export",
    auth,
    requireRole("admin"),
    limiter,
    wrap(async (req, res) => {
      const input = await verify(req);
      await download(req, res, input.format);
    }),
  );
}

module.exports = { registerStreamingExports };
