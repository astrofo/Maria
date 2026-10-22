const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const { hashPassword, verifyPassword, hasPassword } = require("./passwords");
const crypto = require("node:crypto");
const path = require("node:path");
const rateLimit = require("express-rate-limit");
const { database } = require("./db");
const { DatabaseSessionStore } = require("./session-store");
const { createMailer } = require("./mail");
const {
  VERIFICATION_CODE_LENGTH,
  emailCodeMode,
  emailDemoAccounts,
  isDemoEmailAccount,
} = require("./verification-code");
const { registerEmailVerificationRoutes } = require("./registration");
const { registerLoginCodeRoutes } = require("./login-code");
const { registerUploadRoutes } = require("./uploads");
const {
  registerPasswordRecoveryRoutes,
  passwordRecoveryAvailable,
} = require("./password-recovery");
const { registerQuestionnaireRoutes } = require("./questionnaire");
const { registerQuestionnaireImport } = require("./questionnaire-import");
const { registerExportRoutes } = require("./exports");
const { registerOpportunityRoutes } = require("./opportunities");
const { registerStaffTaskRoutes } = require("./staff-tasks");
const { registerAutomationRoutes } = require("./automation");
const { registerReportingRoutes } = require("./reporting");
const { registerCourseRoutes, readLearningSummary } = require("./courses");
const { registerMessagingRoutes } = require("./messaging");
const { registerGroupMessagingRoutes } = require("./group-messaging");
const { registerAssistantRoutes } = require("./assistant");
const V = require("./validation");
const {
  pagination,
  period,
  readPage,
  readSnapshot,
  queryPage,
} = require("./pagination");
const { z } = V;
const roles = { volunteer: 0, coordinator: 1, manager: 2, admin: 3 };
const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const publicProfile = (u) => {
  const { password_hash, auth_version, ...safe } = u;
  return {
    ...safe,
    has_password: hasPassword(password_hash),
    email_demo_account: isDemoEmailAccount(u.email),
  };
};
const staff = (user) => roles[user.role] >= 1;
const manage = (user) => roles[user.role] >= 2;
const audit = (tx, actor, action, type, id) =>
  tx.query(
    "INSERT INTO audit_log(actor_id,action,subject_type,subject_id) VALUES($1,$2,$3,$4)",
    [actor, action, type, id],
  );
const notify = (tx, user, title, body) =>
  tx.query("INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)", [
    user,
    title,
    body,
  ]);
const getOne = async (tx, sql, params, message = "Запись не найдена") => {
  const { rows } = await tx.query(sql, params);
  if (!rows[0]) fail(404, message);
  return rows[0];
};
const safeOperational = (user) => {
  const {
    birth_date,
    rules_accepted_at,
    privacy_accepted_at,
    consent_version,
    ...safe
  } = publicProfile(user);
  return safe;
};
const parseOrigin = (value, setting) => {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname.includes("*") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      `${setting} must contain exact HTTP(S) origins without paths, credentials, queries or wildcards`,
    );
  }
};
function createApp({ db = database, mailer = createMailer() } = {}) {
  const app = express();
  const production = process.env.NODE_ENV === "production";
  const demo = process.env.DEMO_MODE === "true";
  const codeMode = emailCodeMode();
  const verificationAvailable = Boolean(
    mailer.available && typeof mailer.sendVerification === "function",
  );
  const loginCodeAvailable = Boolean(
    mailer.available && typeof mailer.sendLoginCode === "function",
  );
  const demoLoginAvailable = emailDemoAccounts().length > 0;
  const secure = process.env.SESSION_COOKIE_SECURE === "true";
  const origin = process.env.PUBLIC_ORIGIN
    ? parseOrigin(process.env.PUBLIC_ORIGIN.trim(), "PUBLIC_ORIGIN")
    : undefined;
  const frontendOrigins = new Set(
    (process.env.FRONTEND_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => parseOrigin(value, "FRONTEND_ORIGINS")),
  );
  if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    process.env.SESSION_SECRET.startsWith("replace-with-")
  )
    throw new Error("Set a random SESSION_SECRET of at least 32 characters");
  if (
    production &&
    (!secure || !origin || new URL(origin).protocol !== "https:")
  )
    throw new Error(
      "Production requires SESSION_COOKIE_SECURE=true and HTTPS PUBLIC_ORIGIN",
    );
  if (production && demo)
    throw new Error("DEMO_MODE is forbidden in production");
  for (const value of [process.env.PRIVACY_URL, process.env.RULES_URL]) {
    if (value && !["http:", "https:"].includes(new URL(value).protocol))
      throw new Error("Policy and rules URLs must use HTTP or HTTPS");
  }
  const registrationEnabled =
    process.env.REGISTRATION_ENABLED === "true" &&
    (!production || Boolean(process.env.PRIVACY_URL && process.env.RULES_URL));
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "https:"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
    }),
  );
  // Preflight requests carry no session cookie. Handle them before session storage
  // and authentication, while keeping the same allowlist for actual requests.
  const corsMethods = new Set(["GET", "HEAD", "POST", "PATCH", "OPTIONS"]);
  const corsHeaders = new Set(["content-type", "x-csrf-token"]);
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Origin");
    const requestOrigin = req.get("Origin");
    let sameOrigin = origin;
    if (!sameOrigin) {
      try {
        sameOrigin = new URL(`${req.protocol}://${req.get("Host")}`).origin;
      } catch {
        return res.status(400).json({ error: "Некорректный адрес запроса" });
      }
    }
    if (
      requestOrigin &&
      requestOrigin !== sameOrigin &&
      !frontendOrigins.has(requestOrigin)
    )
      return res.status(403).json({ error: "Недопустимый источник запроса" });
    if (requestOrigin) {
      res.set("Access-Control-Allow-Origin", requestOrigin);
      res.set("Access-Control-Allow-Credentials", "true");
      res.set(
        "Access-Control-Expose-Headers",
        "Content-Disposition, Retry-After",
      );
    }
    if (req.method === "OPTIONS") {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
      const requestedMethod = req.get("Access-Control-Request-Method");
      const requestedHeaders = (req.get("Access-Control-Request-Headers") || "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        (requestedMethod &&
          (!requestOrigin || !corsMethods.has(requestedMethod))) ||
        requestedHeaders.some((header) => !corsHeaders.has(header))
      )
        return res
          .status(403)
          .json({ error: "Недопустимый междоменный запрос" });
      res.set("Access-Control-Allow-Methods", [...corsMethods].join(", "));
      res.set("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
      res.set("Access-Control-Max-Age", "600");
      return res.status(204).end();
    }
    next();
  });
  const staticFiles = express.static(path.join(__dirname, "../public"), {
    maxAge: production ? "1h" : 0,
    index: "index.html",
    setHeaders: (res, filename) => {
      if (filename.endsWith("/index.html"))
        res.set("Cache-Control", "no-cache");
    },
  });
  app.use((req, res, next) => {
    if (/^\/api(?:\/|$)/i.test(req.path)) return next();
    return staticFiles(req, res, next);
  });
  app.use("/api/courses", express.json({ limit: "512kb" }));
  app.use("/api/questionnaire-import", express.json({ limit: "1mb" }));
  app.use("/api", express.json({ limit: "64kb" }));
  app.use(
    "/api",
    session({
      store: new DatabaseSessionStore(db),
      name: "dm.sid",
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure, maxAge: 8 * 3600000 },
    }),
  );
  app.use(
    "/api",
    wrap(async (req, res, next) => {
      if (req.session.userId) {
        const { rows } = await db.query("SELECT * FROM users WHERE id=$1", [
          req.session.userId,
        ]);
        const u = rows[0];
        if (
          !u ||
          u.status === "closed" ||
          u.auth_version !== req.session.authVersion
        ) {
          await new Promise((resolve, reject) =>
            req.session.destroy((e) => (e ? reject(e) : resolve())),
          );
          return res
            .status(401)
            .json({ error: "Сессия завершена. Войдите снова." });
        }
        req.user = u;
      }
      next();
    }),
  );
  const auth = (req, _res, next) => {
    if (!req.user)
      return next(
        Object.assign(new Error("Нужно войти в аккаунт"), { status: 401 }),
      );
    next();
  };
  const requireRole = (minimum) => (req, _res, next) => {
    if (!req.user)
      return next(
        Object.assign(new Error("Нужно войти в аккаунт"), { status: 401 }),
      );
    if (roles[req.user.role] < roles[minimum])
      return next(
        Object.assign(new Error("Недостаточно прав"), { status: 403 }),
      );
    next();
  };
  const lockCurrentUser = async (tx, requestUser, minimum) => {
    // Follow the same lock order as role/status mutations before taking any
    // business-record locks, then keep the checked authority until commit.
    await tx.query(
      "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
    );
    const current = await getOne(
      tx,
      "SELECT id,role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
      [requestUser.id],
    );
    if (
      current.status === "closed" ||
      current.auth_version !== requestUser.auth_version
    )
      fail(401, "Сессия завершена. Войдите снова.");
    if (minimum && roles[current.role] < roles[minimum])
      fail(403, "Права доступа изменились");
    return current;
  };
  app.get(
    "/api/health",
    wrap(async (_req, res) => {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    }),
  );
  app.get("/api/config", (_req, res) =>
    res.json({
      demo,
      registration_enabled: registrationEnabled,
      email_verification_available: verificationAvailable,
      email_login_available: loginCodeAvailable,
      email_demo_login_available: demoLoginAvailable,
      email_verification_code_length: VERIFICATION_CODE_LENGTH,
      email_code_mode: codeMode,
      password_recovery_available: passwordRecoveryAvailable(mailer),
      privacy_url: process.env.PRIVACY_URL || null,
      rules_url: process.env.RULES_URL || null,
    }),
  );
  app.get("/api/auth/csrf", (req, res) => {
    if (!req.session.csrfToken)
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.json({ csrfToken: req.session.csrfToken });
  });
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const received = req.get("X-CSRF-Token"),
      expected = req.session.csrfToken;
    if (
      !received ||
      !expected ||
      Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
    )
      return res.status(403).json({
        error: "Обновите страницу и повторите действие",
        code: "CSRF_INVALID",
      });
    next();
  });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Слишком много попыток. Повторите через 15 минут." },
  });
  const loginSession = async (req, u) => {
    await new Promise((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.userId = u.id;
    req.session.authVersion = u.auth_version;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    await new Promise((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
  };
  registerEmailVerificationRoutes(app, {
    db,
    mailer,
    registrationEnabled,
    loginSession,
    publicProfile,
    wrap,
    audit,
  });
  registerLoginCodeRoutes(app, {
    db,
    mailer,
    loginSession,
    publicProfile,
    wrap,
    audit,
  });
  registerPasswordRecoveryRoutes(app, { db, mailer, wrap, audit });
  registerUploadRoutes(app, { db, requireRole, wrap });
  app.post(
    "/api/auth/login",
    loginLimiter,
    wrap(async (req, res) => {
      const d = z
        .object({ email: V.email, password: z.string().min(1).max(256) })
        .parse(req.body);
      const { rows } = await db.query("SELECT * FROM users WHERE email=$1", [
        d.email,
      ]);
      const u = rows[0];
      if (!u)
        return res.status(404).json({
          error:
            "Аккаунт с этой почтой не найден. Зарегистрируйтесь или завершите подтверждение почты.",
          code: "account_not_found",
        });
      if (u.status === "closed")
        return res.status(403).json({
          error: "Вход в этот аккаунт недоступен. Обратитесь к администратору.",
          code: "account_unavailable",
        });
      if (!(await verifyPassword(d.password, u.password_hash)))
        fail(401, "Неверный e-mail или пароль");
      await loginSession(req, u);
      res.json({ user: publicProfile(u), csrfToken: req.session.csrfToken });
    }),
  );
  app.post(
    "/api/auth/logout",
    auth,
    wrap(async (req, res) => {
      await new Promise((resolve, reject) =>
        req.session.destroy((e) => (e ? reject(e) : resolve())),
      );
      res.clearCookie("dm.sid", { httpOnly: true, sameSite: "lax", secure });
      res.status(204).end();
    }),
  );
  app.post(
    "/api/auth/change-password",
    auth,
    loginLimiter,
    wrap(async (req, res) => {
      const d = z
        .object({
          current_password: z.string().min(1).max(256),
          password: V.password,
        })
        .parse(req.body);
      if (!(await verifyPassword(d.current_password, req.user.password_hash)))
        fail(400, "Текущий пароль неверен");
      const hash = await hashPassword(d.password);
      const user = await db.transaction(async (tx) => {
        const u = await getOne(
          tx,
          "UPDATE users SET password_hash=$1,auth_version=auth_version+1,updated_at=NOW() WHERE id=$2 AND auth_version=$3 AND status<>'closed' RETURNING *",
          [hash, req.user.id, req.user.auth_version],
          "Данные входа изменились. Войдите снова.",
        );
        await audit(tx, u.id, "change_password", "user", u.id);
        return u;
      });
      await loginSession(req, user);
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    }),
  );
  app.get("/api/me", auth, (req, res) =>
    res.json({ user: publicProfile(req.user) }),
  );
  app.patch(
    "/api/me",
    auth,
    wrap(async (req, res) => {
      const d = V.profile.parse(req.body);
      const user = await db.transaction(async (tx) => {
        const current = await getOne(
          tx,
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [req.user.id],
        );
        // A request may have authenticated just before the account was closed
        // or its password changed; the locked row is the authority for this write.
        if (
          current.status === "closed" ||
          current.auth_version !== req.user.auth_version
        )
          fail(401, "Сессия завершена. Войдите снова.");
        const questionnaire = await tx.query(
          "SELECT user_id FROM volunteer_questionnaires WHERE user_id=$1",
          [req.user.id],
        );
        // Once an extended questionnaire exists, it owns these matching fields.
        const volunteerInfo = questionnaire.rows.length ? current : d;
        const u = await getOne(
          tx,
          "UPDATE users SET full_name=$1,city=$2,phone=$3,birth_date=$4,interests=$5,skills=$6,experience=$7,participation_format=$8,participation_frequency=$9,gender=COALESCE($11,gender),updated_at=NOW() WHERE id=$10 RETURNING *",
          [
            d.full_name,
            d.city || null,
            d.phone || null,
            d.birth_date || null,
            volunteerInfo.interests,
            volunteerInfo.skills,
            volunteerInfo.experience || null,
            volunteerInfo.participation_format || null,
            volunteerInfo.participation_frequency || null,
            req.user.id,
            d.gender || null,
          ],
        );
        await audit(tx, u.id, "update_profile", "user", u.id);
        return u;
      });
      res.json({ user: publicProfile(user) });
    }),
  );
  const assertVolunteer = async (tx, id) => {
    const u = await getOne(
      tx,
      "SELECT * FROM users WHERE id=$1 FOR SHARE",
      [id],
      "Волонтёр не найден",
    );
    if (u.role !== "volunteer")
      fail(403, "Действие доступно только для волонтёров");
    return u;
  };
  registerOpportunityRoutes(app, {
    db,
    auth,
    requireRole,
    wrap,
    audit,
    notify,
    staff,
    fail,
    getOne,
    assertVolunteer,
  });
  app.get(
    "/api/training",
    auth,
    wrap(async (req, res) => {
      const q = V.text(120).parse(req.query.q || "");
      const from = `FROM training_materials t LEFT JOIN training_completions c
        ON c.material_id=t.id AND c.user_id=$1
        WHERE ($2::boolean OR t.published)
          AND ($3='' OR t.title ILIKE $3 OR t.description ILIKE $3)`;
      const result = await readPage(db, {
        paging: pagination(req.query),
        values: [req.user.id, staff(req.user), q ? `%${q}%` : ""],
        countSql: `SELECT COUNT(*) AS count,
          COUNT(*) FILTER (WHERE c.material_id IS NOT NULL) AS completed,
          COUNT(*) FILTER (WHERE t.required AND t.published) AS required_total,
          COUNT(*) FILTER (WHERE t.required AND t.published AND c.material_id IS NOT NULL) AS required_completed ${from}`,
        itemsSql: `SELECT t.*,c.completed_at IS NOT NULL AS completed,c.completed_at
          ${from} ORDER BY t.required DESC,t.id`,
        summary: (row) => ({
          completed: Number(row.completed),
          required_total: Number(row.required_total),
          required_completed: Number(row.required_completed),
        }),
      });
      res.json(result);
    }),
  );
  app.get(
    "/api/training/:id",
    auth,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const item = await getOne(
        db,
        `SELECT t.*,c.completed_at IS NOT NULL AS completed,c.completed_at
         FROM training_materials t
         LEFT JOIN training_completions c ON c.material_id=t.id AND c.user_id=$1
         WHERE t.id=$2 AND ($3::boolean OR t.published)`,
        [req.user.id, id, staff(req.user)],
      );
      res.json({ item });
    }),
  );
  const trainingValues = (d) => [
    d.title,
    d.description || null,
    d.url || null,
    d.required,
    d.published,
  ];
  app.post(
    "/api/training",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const d = V.training.parse(req.body);
      const item = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "coordinator");
        const item = await getOne(
          tx,
          "INSERT INTO training_materials(title,description,url,required,published) VALUES($1,$2,$3,$4,$5) RETURNING *",
          trainingValues(d),
        );
        await audit(tx, req.user.id, "create", "training", item.id);
        return item;
      });
      res.status(201).json({ item });
    }),
  );
  app.patch(
    "/api/training/:id",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const item = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "coordinator");
        const old = await getOne(
          tx,
          "SELECT * FROM training_materials WHERE id=$1 FOR UPDATE",
          [id],
        );
        const d = V.training.parse({ ...old, ...req.body });
        const item = await getOne(
          tx,
          "UPDATE training_materials SET title=$1,description=$2,url=$3,required=$4,published=$5 WHERE id=$6 RETURNING *",
          [...trainingValues(d), id],
        );
        await audit(tx, req.user.id, "update", "training", id);
        return item;
      });
      res.json({ item });
    }),
  );
  app.post(
    "/api/training/:id/complete",
    auth,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const completion = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user);
        await getOne(
          tx,
          "SELECT id FROM training_materials WHERE id=$1 AND published FOR SHARE",
          [id],
        );
        const c = await getOne(
          tx,
          "INSERT INTO training_completions(user_id,material_id) VALUES($1,$2) ON CONFLICT(user_id,material_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *",
          [req.user.id, id],
        );
        await audit(tx, req.user.id, "complete", "training", id);
        return c;
      });
      res.json({ completion });
    }),
  );
  app.get(
    "/api/participation",
    auth,
    wrap(async (req, res) => {
      const uid = req.query.user_id ? V.id.parse(req.query.user_id) : null;
      const oid = req.query.opportunity_id
        ? V.id.parse(req.query.opportunity_id)
        : null;
      const dates = period(req.query);
      const from = `FROM participation p JOIN users u ON u.id=p.user_id
        WHERE ($1::boolean OR p.user_id=$2) AND ($3::bigint IS NULL OR p.user_id=$3)
          AND ($4::bigint IS NULL OR p.opportunity_id=$4)
          AND ($5::date IS NULL OR p.participated_on >= $5::date)
          AND ($6::date IS NULL OR p.participated_on <= $6::date)
          AND ($7::boolean OR u.role='volunteer')`;
      const result = await readPage(db, {
        paging: pagination(req.query),
        values: [
          staff(req.user),
          req.user.id,
          uid,
          oid,
          dates.date_from,
          dates.date_to,
          req.user.role !== "coordinator",
        ],
        countSql: `SELECT COUNT(*) AS count,COALESCE(SUM(p.hours),0) AS total_hours ${from}`,
        itemsSql: ({ limit, offset }) => `WITH page AS MATERIALIZED (
          SELECT p.*,u.full_name ${from} ORDER BY p.participated_on DESC,p.id DESC
          LIMIT ${limit} OFFSET ${offset}
        ) SELECT page.*,o.title AS opportunity_title FROM page
          LEFT JOIN opportunities o ON o.id=page.opportunity_id
          ORDER BY page.participated_on DESC,page.id DESC`,
        summary: (row) => ({
          entries: Number(row.count),
          total_hours: Number(row.total_hours),
        }),
      });
      res.json(result);
    }),
  );
  app.post(
    "/api/participation",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const d = V.participation.parse(req.body);
      const item = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "coordinator");
        await assertVolunteer(tx, d.user_id);
        let title = d.title;
        if (d.opportunity_id) {
          const o = await getOne(
            tx,
            "SELECT * FROM opportunities WHERE id=$1 FOR UPDATE",
            [d.opportunity_id],
          );
          title = title || o.title;
          const { rows: a } = await tx.query(
            "SELECT id FROM applications WHERE user_id=$1 AND opportunity_id=$2 AND status='accepted'",
            [d.user_id, d.opportunity_id],
          );
          if (!a.length) fail(409, "Сначала подтвердите отклик волонтёра");
          const { rows: p } = await tx.query(
            "SELECT id FROM participation WHERE user_id=$1 AND opportunity_id=$2",
            [d.user_id, d.opportunity_id],
          );
          if (p.length)
            fail(
              409,
              "Часы для этого мероприятия уже записаны. Используйте исправление записи.",
            );
        }
        const item = await getOne(
          tx,
          "INSERT INTO participation(user_id,opportunity_id,title,participated_on,hours,note,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            d.user_id,
            d.opportunity_id || null,
            title,
            d.participated_on,
            d.hours,
            d.note || null,
            req.user.id,
          ],
        );
        await notify(
          tx,
          d.user_id,
          "Участие подтверждено",
          `${title}: ${d.hours} ч.`,
        );
        await audit(tx, req.user.id, "create", "participation", item.id);
        return item;
      });
      res.status(201).json({ item });
    }),
  );
  app.patch(
    "/api/participation/:id",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const d = z
        .object({
          hours: z.coerce.number().positive().max(24),
          participated_on: V.date.optional(),
          note: V.text(2000).nullable().optional(),
        })
        .parse(req.body);
      const item = await db.transaction(async (tx) => {
        const actor = await lockCurrentUser(tx, req.user, "coordinator");
        const old = await getOne(
          tx,
          "SELECT * FROM participation WHERE id=$1 FOR UPDATE",
          [id],
        );
        const owner = await getOne(
          tx,
          "SELECT role FROM users WHERE id=$1 FOR SHARE",
          [old.user_id],
        );
        // Promotion to staff changes the history's read scope as well as its
        // write scope. A guessed record ID must not bypass that boundary.
        if (actor.role === "coordinator" && owner.role !== "volunteer")
          fail(404, "Запись участия не найдена");
        const item = await getOne(
          tx,
          "UPDATE participation SET hours=$1,participated_on=COALESCE($2::date,participated_on),note=$3 WHERE id=$4 RETURNING *",
          [
            d.hours,
            d.participated_on || null,
            d.note === undefined ? old.note : d.note,
            id,
          ],
        );
        await audit(tx, req.user.id, "correct", "participation", id);
        await notify(
          tx,
          old.user_id,
          "Часы участия уточнены",
          `${old.title}: ${d.hours} ч.`,
        );
        return item;
      });
      res.json({ item });
    }),
  );
  app.get(
    "/api/users",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const q = V.text(120).parse(req.query.q || "");
      const city = V.text(120).parse(req.query.city || "");
      const skill = V.text(80).parse(req.query.skill || "");
      const status = req.query.status
        ? z.enum(["new", "active", "paused", "closed"]).parse(req.query.status)
        : null;
      const role = req.query.role
        ? z
            .enum(["volunteer", "coordinator", "manager", "admin"])
            .parse(req.query.role)
        : null;
      const filters = `WHERE ($1::boolean OR role='volunteer') AND (full_name ILIKE $2 OR email ILIKE $2) AND ($3='' OR city ILIKE $3) AND ($4::text IS NULL OR status=$4) AND ($5='' OR EXISTS(SELECT 1 FROM unnest(skills) s WHERE s ILIKE $5)) AND ($6::text IS NULL OR role=$6)`;
      const values = [
        manage(req.user),
        `%${q}%`,
        city ? `%${city}%` : "",
        status,
        skill ? `%${skill}%` : "",
        role,
      ];
      res.json(
        await readPage(db, {
          paging: pagination(req.query),
          values,
          countSql: `SELECT COUNT(*) AS count FROM users ${filters}`,
          itemsSql: `SELECT id,full_name,email,role,city,status,interests,skills,participation_frequency,participation_format,created_at,
            (SELECT COALESCE(SUM(p.hours),0) FROM participation p WHERE p.user_id=users.id) AS total_hours,
            (SELECT COUNT(*)::int FROM participation p WHERE p.user_id=users.id) AS participation_count
            FROM users ${filters} ORDER BY created_at DESC,id DESC`,
        }),
      );
    }),
  );
  app.post(
    "/api/me/consents",
    auth,
    wrap(async (req, res) => {
      z.object({
        rules_accepted: z.literal(true),
        privacy_accepted: z.literal(true),
      })
        .strict()
        .parse(req.body);
      if (!process.env.RULES_URL || !process.env.PRIVACY_URL)
        fail(503, "Документы для согласия пока не настроены");
      const user = await db.transaction(async (tx) => {
        const result = await tx.query(
          "UPDATE users SET rules_accepted_at=COALESCE(rules_accepted_at,NOW()),privacy_accepted_at=COALESCE(privacy_accepted_at,NOW()),consent_version=$2,updated_at=NOW() WHERE id=$1 AND auth_version=$3 AND status<>'closed' RETURNING *",
          [
            req.user.id,
            process.env.CONSENT_VERSION || "1",
            req.session.authVersion,
          ],
        );
        if (!result.rows[0]) fail(403, "Аккаунт недоступен");
        await audit(tx, req.user.id, "accept_policies", "user", req.user.id);
        return publicProfile(result.rows[0]);
      });
      res.json({ user });
    }),
  );
  app.post(
    "/api/users",
    requireRole("manager"),
    wrap(async (req, res) => {
      const data = z
        .object({
          full_name: V.text(120).min(2),
          email: V.email,
          comment: V.text(4000).optional(),
        })
        .parse(req.body);
      const hash = await hashPassword(
        crypto.randomBytes(48).toString("base64url"),
      );
      const user = await db.transaction(async (tx) => {
        const actor = await getOne(
          tx,
          "SELECT role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
          [req.user.id],
        );
        if (
          !manage(actor) ||
          actor.status === "closed" ||
          actor.auth_version !== req.session.authVersion
        )
          fail(403, "Недостаточно прав");
        const result = await tx.query(
          "INSERT INTO users(full_name,email,password_hash,role,status) VALUES($1,$2,$3,'volunteer','new') ON CONFLICT(email) DO NOTHING RETURNING *",
          [data.full_name, data.email, hash],
        );
        if (!result.rows[0])
          fail(
            409,
            "Карточка с этой почтой уже существует. Найдите её в базе.",
          );
        const item = result.rows[0];
        if (data.comment)
          await tx.query(
            "INSERT INTO staff_notes(user_id,author_id,body) VALUES($1,$2,$3)",
            [item.id, req.user.id, data.comment],
          );
        await audit(tx, req.user.id, "create_volunteer_card", "user", item.id);
        return item;
      });
      res.status(201).json({ user: publicProfile(user) });
    }),
  );
  app.get(
    "/api/users/:id",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const result = await readSnapshot(db, async (tx) => {
        const u = await getOne(
          tx,
          "SELECT * FROM users WHERE id=$1",
          [id],
          "Пользователь не найден",
        );
        if (!manage(req.user) && u.role !== "volunteer")
          fail(403, "Недостаточно прав");
        const participation = await queryPage(tx, {
          paging: pagination(req.query, "participation_page"),
          values: [id],
          countSql:
            "SELECT COUNT(*) AS count,COALESCE(SUM(hours),0) AS total_hours FROM participation WHERE user_id=$1",
          itemsSql:
            "SELECT p.*,o.title AS opportunity_title FROM participation p LEFT JOIN opportunities o ON o.id=p.opportunity_id WHERE p.user_id=$1 ORDER BY p.participated_on DESC,p.id DESC",
          summary: (row) => ({
            entries: Number(row.count),
            total_hours: Number(row.total_hours),
          }),
        });
        const applications = await queryPage(tx, {
          paging: pagination(req.query, "applications_page"),
          values: [id],
          countSql:
            "SELECT COUNT(*) AS count FROM applications WHERE user_id=$1",
          itemsSql:
            "SELECT a.*,o.title AS opportunity_title FROM applications a JOIN opportunities o ON o.id=a.opportunity_id WHERE a.user_id=$1 ORDER BY a.created_at DESC,a.id DESC",
        });
        const trainingFrom = `FROM training_materials t LEFT JOIN training_completions c
          ON c.material_id=t.id AND c.user_id=$1 WHERE t.published`;
        const training = await queryPage(tx, {
          paging: pagination(req.query, "training_page"),
          values: [id],
          countSql: `SELECT COUNT(*) AS count,
            COUNT(*) FILTER (WHERE c.material_id IS NOT NULL) AS completed,
            COUNT(*) FILTER (WHERE t.required) AS required_total,
            COUNT(*) FILTER (WHERE t.required AND c.material_id IS NOT NULL) AS required_completed ${trainingFrom}`,
          itemsSql: `SELECT t.*,c.completed_at IS NOT NULL AS completed,c.completed_at
            ${trainingFrom} ORDER BY t.required DESC,t.id`,
          summary: (row) => ({
            completed: Number(row.completed),
            required_total: Number(row.required_total),
            required_completed: Number(row.required_completed),
          }),
        });
        const learning = await readLearningSummary(tx, id);
        const result = {
          learning,
          user: manage(req.user) ? publicProfile(u) : safeOperational(u),
          participation,
          applications,
          training,
          summary: {
            total_hours: participation.summary.total_hours,
            participation_count: participation.total,
            application_count: applications.total,
            training_count: training.total,
            training_completed: training.summary.completed,
            required_training_total: learning.required_total,
            required_training_completed: learning.required_completed,
          },
        };
        if (manage(req.user))
          result.notes = await queryPage(tx, {
            paging: pagination(req.query, "notes_page"),
            values: [id],
            countSql:
              "SELECT COUNT(*) AS count FROM staff_notes WHERE user_id=$1",
            itemsSql:
              "SELECT n.*,u.full_name AS author_name FROM staff_notes n LEFT JOIN users u ON u.id=n.author_id WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id DESC",
          });
        return result;
      });
      res.json(result);
    }),
  );
  app.patch(
    "/api/users/:id/status",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const status = z
        .enum(["new", "active", "paused", "closed"])
        .parse(req.body.status);
      const user = await db.transaction(async (tx) => {
        const admins = await tx.query(
          "SELECT id,status FROM users WHERE role='admin' ORDER BY id FOR UPDATE",
        );
        const actor = await getOne(
          tx,
          "SELECT role,status,auth_version FROM users WHERE id=$1",
          [req.user.id],
        );
        if (
          roles[actor.role] < roles.coordinator ||
          actor.status === "closed" ||
          actor.auth_version !== req.user.auth_version
        )
          fail(403, "Права доступа изменились");
        const old = await getOne(
          tx,
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (old.role !== "volunteer" && actor.role !== "admin")
          fail(403, "Только администратор изменяет статус сотрудника");
        if (String(req.user.id) === String(id) && status === "closed")
          fail(400, "Нельзя закрыть собственный аккаунт");
        if (
          old.role === "admin" &&
          old.status !== "closed" &&
          status === "closed" &&
          admins.rows.filter((a) => a.status !== "closed").length <= 1
        )
          fail(409, "Должен остаться хотя бы один администратор");
        const user = await getOne(
          tx,
          "UPDATE users SET status=$1,updated_at=NOW(),auth_version=auth_version+CASE WHEN $1='closed' THEN 1 ELSE 0 END WHERE id=$2 RETURNING *",
          [status, id],
        );
        await audit(tx, req.user.id, "change_status", "user", id);
        return user;
      });
      res.json({
        user: manage(req.user) ? publicProfile(user) : safeOperational(user),
      });
    }),
  );
  app.patch(
    "/api/users/:id/role",
    requireRole("admin"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const role = z
        .enum(["volunteer", "coordinator", "manager", "admin"])
        .parse(req.body.role);
      if (String(req.user.id) === String(id))
        fail(400, "Нельзя менять собственную роль");
      const user = await db.transaction(async (tx) => {
        const admins = await tx.query(
          "SELECT id,status FROM users WHERE role='admin' ORDER BY id FOR UPDATE",
        );
        const actor = await getOne(
          tx,
          "SELECT role,status,auth_version FROM users WHERE id=$1",
          [req.user.id],
        );
        if (
          actor.role !== "admin" ||
          actor.status === "closed" ||
          actor.auth_version !== req.user.auth_version
        )
          fail(403, "Права доступа изменились");
        const old = await getOne(
          tx,
          "SELECT role,status FROM users WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (
          old.role === "admin" &&
          old.status !== "closed" &&
          role !== "admin" &&
          admins.rows.filter((a) => a.status !== "closed").length <= 1
        )
          fail(409, "Должен остаться хотя бы один администратор");
        const user = await getOne(
          tx,
          "UPDATE users SET role=$1,updated_at=NOW() WHERE id=$2 RETURNING *",
          [role, id],
        );
        await audit(tx, req.user.id, "change_role", "user", id);
        return user;
      });
      res.json({ user: publicProfile(user) });
    }),
  );
  app.post(
    "/api/users/:id/notes",
    requireRole("manager"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const body = V.text(4000).min(1).parse(req.body.body);
      const item = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "manager");
        await getOne(tx, "SELECT id FROM users WHERE id=$1", [id]);
        const n = await getOne(
          tx,
          "INSERT INTO staff_notes(user_id,author_id,body) VALUES($1,$2,$3) RETURNING *",
          [id, req.user.id, body],
        );
        await audit(tx, req.user.id, "create_note", "user", id);
        return n;
      });
      res.status(201).json({ item });
    }),
  );
  app.post(
    "/api/users/:id/thanks",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const message = V.text(2000).min(2).parse(req.body.message);
      const item = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "coordinator");
        await assertVolunteer(tx, id);
        const item = await getOne(
          tx,
          "INSERT INTO thanks(user_id,author_id,message) VALUES($1,$2,$3) RETURNING *",
          [id, req.user.id, message],
        );
        await notify(tx, id, "Спасибо за вашу помощь!", message);
        await audit(tx, req.user.id, "thank", "user", id);
        return item;
      });
      res.status(201).json({ item });
    }),
  );
  app.get(
    "/api/thanks",
    auth,
    wrap(async (req, res) => {
      res.json(
        await readPage(db, {
          paging: pagination(req.query),
          values: [req.user.id],
          countSql: "SELECT COUNT(*) AS count FROM thanks WHERE user_id=$1",
          itemsSql:
            "SELECT t.*,u.full_name AS author_name FROM thanks t LEFT JOIN users u ON u.id=t.author_id WHERE t.user_id=$1 ORDER BY t.created_at DESC,t.id DESC",
        }),
      );
    }),
  );
  registerCourseRoutes(app, { db, auth, requireRole, wrap, audit });
  registerMessagingRoutes(app, { db, auth, requireRole, wrap, audit, notify });
  registerGroupMessagingRoutes(app, { db, auth, wrap, audit });
  registerAssistantRoutes(app, {
    db,
    wrap,
    registrationEnabled,
    mailAvailable: mailer.available,
    verificationAvailable,
  });
  registerReportingRoutes(app, { db, auth, requireRole, wrap, getOne });
  app.get(
    "/api/audit",
    requireRole("admin"),
    wrap(async (req, res) => {
      res.json(
        await readPage(db, {
          paging: pagination(req.query),
          countSql: "SELECT COUNT(*) AS count FROM audit_log",
          itemsSql:
            "SELECT a.*,u.full_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC",
        }),
      );
    }),
  );
  registerQuestionnaireRoutes(app, { db, auth, requireRole, wrap, audit });
  registerQuestionnaireImport(app, {
    db,
    requireRole,
    wrap,
    lockCurrentUser,
    audit,
  });
  registerExportRoutes(app, { db, auth, requireRole, wrap, audit });
  registerStaffTaskRoutes(app, { db, auth, requireRole, wrap, audit, notify });
  registerAutomationRoutes(app, { db, auth, requireRole, wrap, audit });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Метод API не найден" }),
  );
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return _next(err);
    if (res.destroyed) return;
    if (err.name === "ZodError")
      return res.status(400).json({
        error: "Проверьте поля формы",
        details: err.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (err.code === "23505")
      return res.status(409).json({ error: "Такая запись уже существует" });
    if (
      ["23503", "23514", "22007", "22008", "22P02", "22003"].includes(err.code)
    )
      return res.status(400).json({ error: "Некорректные данные" });
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "Некорректный JSON" });
    if (err.type === "entity.too.large")
      return res.status(413).json({ error: "Запрос слишком большой" });
    if (
      [
        "DB_TIMEOUT",
        "57014",
        "55P03",
        "53300",
        "57P03",
        "ECONNREFUSED",
        "ETIMEDOUT",
      ].includes(err.code)
    )
      return res.status(503).set("Retry-After", "3").json({
        error:
          "Сервер занят или база временно недоступна. Повторите действие через несколько секунд.",
        code: "DATABASE_BUSY",
      });
    if (
      ["required_course_incomplete", "required_course_unavailable"].includes(
        err.code,
      )
    )
      return res.status(409).json({
        error: err.message,
        code: err.code,
        required_course_id: err.required_course_id,
      });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("Unhandled request error:", err.code || err.name);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  });
  return app;
}
module.exports = { createApp };
