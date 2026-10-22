const { createHash, createHmac, randomUUID } = require("node:crypto");
const { z, id } = require("./validation");

const text = (n) => z.string().trim().max(n);
const localImage = text(1000).refine(
  (v) =>
    !v ||
    (/^\/(?:assets|uploads)\/[a-zA-Z0-9_./-]+$/.test(v) && !v.includes("..")),
  "Укажите загруженное изображение",
);
const resource = text(2000).refine((v) => {
  if (
    !v ||
    (/^\/(?:assets|uploads)\/[a-zA-Z0-9_./-]+$/.test(v) && !v.includes(".."))
  )
    return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}, "Нужен HTTPS-адрес материала");
const uuid = z.string().uuid();
const question = z
  .object({
    id: uuid,
    prompt: text(2000),
    options: z
      .array(z.object({ id: uuid, text: text(1000) }).strict())
      .min(2)
      .max(8),
    correct_option_id: uuid.nullable().default(null),
    explanation: text(4000).default(""),
  })
  .strict()
  .refine(
    (q) =>
      new Set(q.options.map((o) => o.id)).size === q.options.length &&
      (!q.correct_option_id ||
        q.options.some((o) => o.id === q.correct_option_id)),
    "Проверьте варианты ответа",
  );
const lesson = z
  .object({
    id: uuid,
    title: text(200),
    type: z.enum(["video", "text", "quiz"]),
    minutes: z.number().int().min(0).max(10000).default(0),
    body: text(30000).default(""),
    media_url: resource.default(""),
    image_url: localImage.default(""),
    image_alt: text(400).default(""),
    caption: text(1000).default(""),
    quote: text(2000).default(""),
    tips: z
      .array(z.object({ title: text(200), body: text(2000) }).strict())
      .max(10)
      .default([]),
    attachment_url: resource.default(""),
    attachment_label: text(200).default(""),
    transcript: text(20000).default(""),
    captions_url: resource.default(""),
    questions: z.array(question).max(30).default([]),
    pass_count: z.number().int().min(1).max(30).default(1),
    attempt_limit: z.number().int().min(1).max(100).nullable().default(null),
    time_limit_minutes: z
      .number()
      .int()
      .min(1)
      .max(180)
      .nullable()
      .default(null),
  })
  .strict()
  .refine(
    (l) => new Set(l.questions.map((q) => q.id)).size === l.questions.length,
    "Вопросы должны иметь разные идентификаторы",
  );
const time = z.string().datetime({ offset: true }).nullable().default(null);
const documentSchema = z
  .object({
    title: text(200).min(2),
    description: text(4000).default(""),
    outcomes: text(4000).default(""),
    topic: text(100).default(""),
    author: text(200).default(""),
    cover_url: localImage.default(""),
    cover_alt: text(400).default(""),
    required: z.boolean().default(false),
    audience: z.enum(["all", "new", "active"]).default("all"),
    order: z.enum(["free", "sequential"]).default("free"),
    keep_access: z.boolean().default(true),
    starts_at: time,
    ends_at: time,
    result_message: text(2000).default(""),
    lessons: z.array(lesson).max(50).default([]),
  })
  .strict()
  .refine(
    (d) =>
      !d.starts_at ||
      !d.ends_at ||
      Date.parse(d.ends_at) > Date.parse(d.starts_at),
    "Окончание должно быть позже начала",
  )
  .refine(
    (d) => new Set(d.lessons.map((l) => l.id)).size === d.lessons.length,
    "Уроки должны иметь разные идентификаторы",
  )
  .refine(
    (d) => Buffer.byteLength(JSON.stringify(d)) <= 400 * 1024,
    "Курс слишком большой: разделите материал на несколько курсов",
  );
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const editor = (user) => ["manager", "admin"].includes(user.role);
const staff = (user) => ["coordinator", "manager", "admin"].includes(user.role);
// Do not expose a plain content digest: a short quiz with blank explanation
// would otherwise let a client enumerate its answer keys offline.
const revision = (l) =>
  createHmac("sha256", process.env.SESSION_SECRET)
    .update(`course-revision-v1\0${l.content_hash}`)
    .digest("hex");

function normalizeDocument(raw) {
  const d = documentSchema.parse(raw);
  // The hash excludes cosmetic headings/duration, but includes every material
  // and grading rule. Changing a lesson never completes its new contents.
  d.lessons = d.lessons.map((l) => ({
    ...l,
    content_hash: createHash("sha256")
      .update(
        JSON.stringify({
          type: l.type,
          body: l.body,
          media_url: l.media_url,
          image_url: l.image_url,
          tips: l.tips,
          quote: l.quote,
          attachment_url: l.attachment_url,
          transcript: l.transcript,
          questions: l.questions,
          pass_count: l.pass_count,
          attempt_limit: l.attempt_limit,
          time_limit_minutes: l.time_limit_minutes,
        }),
      )
      .digest("hex"),
  }));
  return d;
}
function publicationIssues(d) {
  const issues = [];
  if (!d.title || !d.description || !d.cover_url || !d.cover_alt)
    issues.push("Добавьте название, описание, обложку и её описание.");
  if (!d.lessons.length) issues.push("Добавьте хотя бы один урок.");
  for (const l of d.lessons) {
    if (
      !l.title ||
      (l.type === "text" && !l.body) ||
      (l.type === "video" && !l.media_url)
    )
      issues.push(`Заполните материал урока «${l.title || "Без названия"}».`);
    if (
      l.type === "quiz" &&
      (!l.questions.length ||
        l.pass_count > l.questions.length ||
        l.questions.some(
          (q) =>
            !q.prompt || !q.correct_option_id || q.options.some((o) => !o.text),
        ))
    )
      issues.push(
        `Проверьте вопросы, правильные ответы и порог теста «${l.title || "Без названия"}».`,
      );
  }
  return issues;
}
async function lockActor(tx, actor, editing = false) {
  await tx.query(
    "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
  );
  const u = (
    await tx.query(
      "SELECT id,role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
      [actor.id],
    )
  ).rows[0];
  if (
    !u ||
    u.status === "closed" ||
    String(u.auth_version) !== String(actor.auth_version)
  )
    fail(403, "Права изменились. Войдите снова.");
  if (editing ? !editor(u) : u.role !== "volunteer")
    fail(403, "Недостаточно прав");
  return u;
}
const visibleSQL = `($2::boolean OR (c.status='published'
  AND (c.document->>'audience'='all' OR c.document->>'audience'=$3)
  AND (c.document->>'starts_at' IS NULL OR (c.document->>'starts_at')::timestamptz<=NOW())
  AND (c.document->>'ends_at' IS NULL OR (c.document->>'ends_at')::timestamptz>NOW())))`;
async function getCourse(tx, courseId, user, lock = false) {
  const c = (
    await tx.query(
      `SELECT c.* FROM courses c WHERE c.id=$1 AND ${visibleSQL} AND (c.archived_at IS NULL OR $2::boolean OR EXISTS(SELECT 1 FROM course_enrollments ce WHERE ce.course_id=c.id AND ce.user_id=$4))${lock ? " FOR UPDATE" : ""}`,
      [courseId, staff(user), user.status, user.id],
    )
  ).rows[0];
  if (!c) fail(404, "Курс не найден или пока недоступен");
  return c;
}
async function progress(tx, c, userId) {
  const enrollment =
    (
      await tx.query(
        "SELECT * FROM course_enrollments WHERE course_id=$1 AND user_id=$2",
        [c.id, userId],
      )
    ).rows[0] || null;
  const rows = (
    await tx.query(
      "SELECT * FROM course_lesson_progress WHERE course_id=$1 AND user_id=$2",
      [c.id, userId],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.lesson_id, r]));
  let completed = 0;
  const lessons = c.document.lessons.map((l) => {
    const p = byId.get(l.id),
      valid = p?.content_hash === l.content_hash;
    if (valid && p.completed_at) completed++;
    return {
      id: l.id,
      completed: Boolean(valid && p.completed_at),
      position_seconds: valid ? p.position_seconds : 0,
      attempts: valid ? p.attempts : 0,
    };
  });
  return {
    enrolled: Boolean(enrollment),
    last_lesson_id: enrollment?.last_lesson_id || null,
    lessons,
    completed,
    total: lessons.length,
    percent: lessons.length
      ? Math.round((completed / lessons.length) * 100)
      : 0,
    finished: lessons.length > 0 && completed === lessons.length,
  };
}
function publicDocument(d, p, preview = false) {
  let previousComplete = true;
  return {
    ...d,
    lessons: d.lessons.map((l) => {
      const complete = p.lessons.find((x) => x.id === l.id)?.completed;
      const locked =
        !preview &&
        ((d.order === "sequential" && !previousComplete) ||
          (p.finished && !d.keep_access));
      previousComplete = previousComplete && complete;
      const { content_hash, questions, ...plain } = l;
      if (locked)
        return {
          id: l.id,
          title: l.title,
          type: l.type,
          minutes: l.minutes,
          locked: true,
        };
      return {
        ...plain,
        locked: false,
        revision: revision(l),
        questions: questions.map(
          ({ correct_option_id, explanation, ...q }) => q,
        ),
      };
    }),
  };
}
async function responseCourse(tx, c, user, editing = false) {
  const p = await progress(tx, c, user.id);
  const document = editing
    ? {
        ...c.document,
        lessons: c.document.lessons.map(({ content_hash, ...l }) => l),
      }
    : publicDocument(c.document, p, staff(user));
  return {
    item: {
      id: c.id,
      status: c.status,
      archived_at: c.archived_at,
      version: c.version,
      document,
      progress: p,
      preview: staff(user),
      ...(editing ? { publication_issues: publicationIssues(c.document) } : {}),
    },
  };
}
async function currentLesson(tx, c, user, lessonId) {
  const l = c.document.lessons.find((l) => l.id === lessonId);
  if (!l) fail(404, "Урок не найден");
  const p = await progress(tx, c, user.id);
  if (!p.enrolled) fail(409, "Сначала запишитесь на курс");
  if (publicDocument(c.document, p).lessons.find((x) => x.id === l.id).locked)
    fail(403, "Этот урок пока недоступен");
  await tx.query(
    `INSERT INTO course_lesson_progress(course_id,user_id,lesson_id,content_hash) VALUES($1,$2,$3,$4)
    ON CONFLICT(course_id,user_id,lesson_id) DO UPDATE SET
    content_hash=EXCLUDED.content_hash,
    completed_at=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.completed_at END,
    position_seconds=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.position_seconds ELSE 0 END,
    attempts=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.attempts ELSE 0 END,
    active_attempt=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.active_attempt END,
    attempt_started_at=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.attempt_started_at END,
    last_attempt=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.last_attempt END,
    last_result=CASE WHEN course_lesson_progress.content_hash=EXCLUDED.content_hash THEN course_lesson_progress.last_result END`,
    [c.id, user.id, l.id, l.content_hash],
  );
  await tx.query(
    "UPDATE course_enrollments SET last_lesson_id=$3,updated_at=NOW() WHERE course_id=$1 AND user_id=$2",
    [c.id, user.id, l.id],
  );
  const row = (
    await tx.query(
      "SELECT * FROM course_lesson_progress WHERE course_id=$1 AND user_id=$2 AND lesson_id=$3 FOR UPDATE",
      [c.id, user.id, l.id],
    )
  ).rows[0];
  return { l, row };
}

// Call inside an existing authorized user-detail transaction for staff views.
// This helper performs no authorization; the public route always uses req.user.
async function readLearningSummary(tx, userId) {
  const legacy = (
    await tx.query(
      `SELECT COUNT(*)::int AS total,COUNT(t.id) FILTER (WHERE tc.completed_at IS NOT NULL)::int AS completed
    FROM training_materials t LEFT JOIN training_completions tc ON tc.material_id=t.id AND tc.user_id=$1
    WHERE t.published AND t.required`,
      [userId],
    )
  ).rows[0];
  const courses = (
    await tx.query(
      `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE p.completed_at IS NOT NULL)::int AS completed
    FROM courses c JOIN users u ON u.id=$1 CROSS JOIN LATERAL jsonb_array_elements(c.document->'lessons') l
    LEFT JOIN course_lesson_progress p ON p.course_id=c.id AND p.user_id=u.id AND p.lesson_id=l->>'id' AND p.content_hash=l->>'content_hash'
    WHERE c.archived_at IS NULL AND c.status='published' AND (c.document->>'required')::boolean
    AND (c.document->>'audience'='all' OR c.document->>'audience'=u.status)
    AND (c.document->>'starts_at' IS NULL OR (c.document->>'starts_at')::timestamptz<=NOW())
    AND (c.document->>'ends_at' IS NULL OR (c.document->>'ends_at')::timestamptz>NOW())`,
      [userId],
    )
  ).rows[0];
  return {
    required_total: legacy.total + courses.total,
    required_completed: legacy.completed + courses.completed,
    legacy_required_total: legacy.total,
    legacy_required_completed: legacy.completed,
    course_required_total: courses.total,
    course_required_completed: courses.completed,
  };
}

function registerCourseRoutes(app, { db, auth, requireRole, wrap, audit }) {
  app.get(
    "/api/courses/summary",
    auth,
    wrap(async (req, res) => {
      res.json({
        summary: await db.transaction((tx) =>
          readLearningSummary(tx, req.user.id),
        ),
      });
    }),
  );
  app.get(
    "/api/courses",
    auth,
    wrap(async (req, res) => {
      const q = text(120).parse(req.query.q || ""),
        topic = text(100).parse(req.query.topic || "");
      const filter = z
        .enum([
          "",
          "draft",
          "published",
          "not_started",
          "in_progress",
          "completed",
        ])
        .parse(req.query.status || "");
      const type = z
        .enum(["", "required", "optional"])
        .parse(req.query.type || "");
      const sort = z
        .enum(["newest", "title", "duration"])
        .parse(req.query.sort || "newest");
      const archived =
        z.enum(["false", "true"]).parse(req.query.archived || "false") ===
        "true";
      const history =
        z.enum(["false", "true"]).parse(req.query.history || "false") ===
        "true";
      if (archived && !staff(req.user))
        fail(403, "Корзина курсов доступна только команде");
      if (history && staff(req.user))
        fail(400, "Для удалённых курсов используйте корзину");
      const orderBy = {
        newest: "c.id DESC",
        title: "LOWER(c.document->>'title') ASC, c.id DESC",
        duration: "minutes ASC, c.id DESC",
      }[sort];
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(req.query.page || 1);
      const data = await db.transaction(async (tx) => {
        // Course metadata only; never send quiz keys or lesson bodies in a catalog.
        const base = `FROM courses c LEFT JOIN course_enrollments e ON e.course_id=c.id AND e.user_id=$1
        WHERE ${visibleSQL}${history ? " AND e.user_id IS NOT NULL" : ""} AND c.archived_at IS ${archived || history ? "NOT " : ""}NULL`;
        const activeBase = `FROM courses c LEFT JOIN course_enrollments e ON e.course_id=c.id AND e.user_id=$1
        WHERE ${visibleSQL} AND c.archived_at IS NULL`;
        const values = [req.user.id, staff(req.user), req.user.status];
        const select = `SELECT c.id,c.status,c.archived_at,c.version,c.document->>'title' AS title,c.document->>'description' AS description,
        c.document->>'topic' AS topic,c.document->>'cover_url' AS cover_url,c.document->>'cover_alt' AS cover_alt,
        (c.document->>'required')::boolean AS required,jsonb_array_length(c.document->'lessons') AS lesson_count,
        COALESCE((SELECT SUM((l->>'minutes')::int) FROM jsonb_array_elements(c.document->'lessons') l),0)::int AS minutes,
        e.user_id IS NOT NULL AS enrolled,e.last_lesson_id,
        (SELECT COUNT(*)::int FROM jsonb_array_elements(c.document->'lessons') l JOIN course_lesson_progress p
          ON p.course_id=c.id AND p.user_id=$1 AND p.lesson_id=l->>'id' AND p.content_hash=l->>'content_hash' WHERE p.completed_at IS NOT NULL) AS completed,
        (SELECT COUNT(*)::int FROM course_enrollments ce WHERE ce.course_id=c.id) AS participants,
        (SELECT COUNT(*)::int FROM course_enrollments ce WHERE ce.course_id=c.id AND jsonb_array_length(c.document->'lessons')>0
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.document->'lessons') l WHERE NOT EXISTS(
            SELECT 1 FROM course_lesson_progress p WHERE p.course_id=c.id AND p.user_id=ce.user_id AND p.lesson_id=l->>'id' AND p.content_hash=l->>'content_hash' AND p.completed_at IS NOT NULL))) AS completions`;
        const filterSql = ` AND ($4='' OR c.document->>'title' ILIKE $4 OR c.document->>'topic' ILIKE $4)
        AND ($5='' OR c.document->>'topic'=$5) AND ($6='' OR ($6='required')=(c.document->>'required')::boolean)
        AND ($7='' OR c.status=$7 OR $7='not_started' AND e.user_id IS NULL
          OR $7='in_progress' AND e.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.document->'lessons') l
            WHERE NOT EXISTS(SELECT 1 FROM course_lesson_progress p WHERE p.course_id=c.id AND p.user_id=$1 AND p.lesson_id=l->>'id' AND p.content_hash=l->>'content_hash' AND p.completed_at IS NOT NULL))
          OR $7='completed' AND jsonb_array_length(c.document->'lessons')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.document->'lessons') l
            WHERE NOT EXISTS(SELECT 1 FROM course_lesson_progress p WHERE p.course_id=c.id AND p.user_id=$1 AND p.lesson_id=l->>'id' AND p.content_hash=l->>'content_hash' AND p.completed_at IS NOT NULL)))`;
        const args = [...values, q ? `%${q}%` : "", topic, type, filter];
        const total = Number(
          (await tx.query(`SELECT COUNT(*) ${base}${filterSql}`, args)).rows[0]
            .count,
        );
        const items = (
          await tx.query(
            `${select} ${base}${filterSql} ORDER BY ${orderBy} LIMIT 30 OFFSET $8`,
            [...args, (page - 1) * 30],
          )
        ).rows;
        const required = (
          await tx.query(
            `${select} ${activeBase} AND (c.document->>'required')::boolean ORDER BY c.id LIMIT 100`,
            values,
          )
        ).rows;
        const requiredCount = Number(
          (
            await tx.query(
              `SELECT COUNT(*) ${activeBase} AND (c.document->>'required')::boolean`,
              values,
            )
          ).rows[0].count,
        );
        const continuation =
          (
            await tx.query(
              `${select} ${activeBase} AND e.user_id IS NOT NULL AND NOT (c.document->>'required')::boolean
        ORDER BY e.updated_at DESC LIMIT 1`,
              values,
            )
          ).rows[0] || null;
        const topics = (
          await tx.query(
            `SELECT DISTINCT c.document->>'topic' AS topic ${base} AND c.document->>'topic'<>'' ORDER BY topic LIMIT 200`,
            values,
          )
        ).rows.map((r) => r.topic);
        const summary = (
          await tx.query(
            `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE c.status='published')::int AS published,
        COUNT(*) FILTER (WHERE c.status='draft')::int AS drafts ${activeBase}`,
            values,
          )
        ).rows[0];
        const clean = (r) => {
          if (!staff(req.user)) {
            delete r.participants;
            delete r.completions;
          }
          return r;
        };
        return {
          items: items.map(clean),
          required: required.map(clean),
          required_count: requiredCount,
          continuation: continuation && clean(continuation),
          topics,
          total,
          page,
          page_size: 30,
          sort,
          archived,
          history,
          summary,
        };
      });
      res.json(data);
    }),
  );
  app.get(
    "/api/courses/:id/editor",
    requireRole("manager"),
    wrap(async (req, res) => {
      res.json(
        await db.transaction(async (tx) =>
          responseCourse(
            tx,
            await getCourse(tx, id.parse(req.params.id), req.user),
            req.user,
            true,
          ),
        ),
      );
    }),
  );
  app.get(
    "/api/courses/:id",
    auth,
    wrap(async (req, res) => {
      res.json(
        await db.transaction(async (tx) =>
          responseCourse(
            tx,
            await getCourse(tx, id.parse(req.params.id), req.user),
            req.user,
          ),
        ),
      );
    }),
  );
  app.post(
    "/api/courses",
    requireRole("manager"),
    wrap(async (req, res) => {
      const d = normalizeDocument(req.body.document);
      const result = await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const c = (
          await tx.query(
            "INSERT INTO courses(document,created_by) VALUES($1,$2) RETURNING *",
            [JSON.stringify(d), req.user.id],
          )
        ).rows[0];
        await audit(tx, req.user.id, "create", "course", c.id);
        return responseCourse(tx, c, req.user, true);
      });
      res.status(201).json(result);
    }),
  );
  app.patch(
    "/api/courses/:id",
    requireRole("manager"),
    wrap(async (req, res) => {
      const input = z
        .object({ document: z.unknown(), expected_version: id })
        .strict()
        .parse(req.body);
      const d = normalizeDocument(input.document);
      const result = await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const c = await getCourse(tx, id.parse(req.params.id), req.user, true);
        if (c.archived_at)
          fail(409, "Курс находится в корзине. Сначала восстановите его.");
        if (c.version !== input.expected_version)
          fail(
            409,
            "Курс изменён в другом окне. Сохраните свой текст и откройте актуальную версию.",
          );
        if (c.status === "published" && publicationIssues(d).length)
          fail(
            400,
            "Сначала снимите курс с публикации, чтобы сохранить незаполненные материалы.",
          );
        const updated = (
          await tx.query(
            "UPDATE courses SET document=$2,version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *",
            [c.id, JSON.stringify(d)],
          )
        ).rows[0];
        await audit(tx, req.user.id, "update", "course", c.id);
        return responseCourse(tx, updated, req.user, true);
      });
      res.json(result);
    }),
  );
  app.post(
    "/api/courses/:id/publication",
    requireRole("manager"),
    wrap(async (req, res) => {
      const input = z
        .object({ expected_version: id, published: z.boolean() })
        .strict()
        .parse(req.body);
      const result = await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const c = await getCourse(tx, id.parse(req.params.id), req.user, true);
        if (c.archived_at)
          fail(409, "Курс находится в корзине. Сначала восстановите его.");
        if (c.version !== input.expected_version)
          fail(409, "Курс изменился. Откройте актуальную версию.");
        const issues = publicationIssues(c.document);
        if (input.published && issues.length) fail(400, issues.join(" "));
        const updated = (
          await tx.query(
            "UPDATE courses SET status=$2,version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *",
            [c.id, input.published ? "published" : "draft"],
          )
        ).rows[0];
        await audit(
          tx,
          req.user.id,
          input.published ? "publish" : "unpublish",
          "course",
          c.id,
        );
        return responseCourse(tx, updated, req.user, true);
      });
      res.json(result);
    }),
  );
  for (const restoring of [false, true]) {
    app.post(
      `/api/courses/:id/${restoring ? "restore" : "archive"}`,
      requireRole("manager"),
      wrap(async (req, res) => {
        const input = z
          .object({ expected_version: id })
          .strict()
          .parse(req.body);
        const result = await db.transaction(async (tx) => {
          await lockActor(tx, req.user, true);
          const c = await getCourse(
            tx,
            id.parse(req.params.id),
            req.user,
            true,
          );
          if (c.version !== input.expected_version)
            fail(409, "Курс изменился. Откройте актуальную версию.");
          if (restoring ? !c.archived_at : Boolean(c.archived_at))
            fail(
              409,
              restoring
                ? "Курс уже восстановлен."
                : "Курс уже находится в корзине.",
            );
          if (!restoring) {
            // Event writes acquire a shared lock on their required course. The
            // exclusive course lock serializes this reference check with them.
            const references = await tx.query(
              "SELECT id FROM opportunities WHERE required_course_id=$1 AND archived_at IS NULL AND status IN ('open','draft') LIMIT 1",
              [c.id],
            );
            if (references.rows.length)
              fail(
                409,
                "Курс обязателен для действующего мероприятия. Сначала замените или уберите подготовительный курс в мероприятии.",
              );
          }
          const updated = (
            await tx.query(
              restoring
                ? "UPDATE courses SET archived_at=NULL,archived_by=NULL,version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *"
                : "UPDATE courses SET archived_at=NOW(),archived_by=$2,version=version+1,updated_at=NOW() WHERE id=$1 RETURNING *",
              restoring ? [c.id] : [c.id, req.user.id],
            )
          ).rows[0];
          await audit(
            tx,
            req.user.id,
            restoring ? "restore" : "archive",
            "course",
            c.id,
          );
          return responseCourse(tx, updated, req.user, true);
        });
        res.json(result);
      }),
    );
  }
  app.post(
    "/api/courses/:id/enroll",
    auth,
    wrap(async (req, res) => {
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const c = await getCourse(tx, id.parse(req.params.id), actor, true);
        if (c.archived_at) fail(409, "Запись на удалённый курс закрыта.");
        const inserted = await tx.query(
          "INSERT INTO course_enrollments(course_id,user_id,last_lesson_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id",
          [c.id, actor.id, c.document.lessons[0]?.id || null],
        );
        if (inserted.rows.length)
          await audit(tx, actor.id, "enroll", "course", c.id);
        return responseCourse(tx, c, actor);
      });
      res.json(result);
    }),
  );
  const action = (name, handler) =>
    app.post(
      `/api/courses/:id/lessons/:lessonId/${name}`,
      auth,
      wrap(async (req, res) => {
        const result = await db.transaction(async (tx) => {
          const actor = await lockActor(tx, req.user);
          const c = await getCourse(tx, id.parse(req.params.id), actor, true);
          const { l, row } = await currentLesson(
            tx,
            c,
            actor,
            uuid.parse(req.params.lessonId),
          );
          const extra = await handler(tx, c, l, row, actor, req.body);
          return { ...(await responseCourse(tx, c, actor)), ...extra };
        });
        res.json(result);
      }),
    );
  action("visit", async (_tx, _c, l, _row, _user, body) => {
    if (body.revision !== revision(l))
      fail(409, "Материал изменился. Откройте его снова.");
  });
  action("complete", async (tx, c, l, row, user, body) => {
    const requestedRevision = z.string().length(64).parse(body.revision);
    if (requestedRevision !== revision(l))
      fail(409, "Материал изменился. Откройте его снова.");
    if (l.type === "quiz") fail(400, "Для завершения теста отправьте ответы");
    if (!row.completed_at) {
      await tx.query(
        "UPDATE course_lesson_progress SET completed_at=NOW(),updated_at=NOW() WHERE course_id=$1 AND user_id=$2 AND lesson_id=$3",
        [c.id, user.id, l.id],
      );
      await audit(tx, user.id, "lesson_complete", "course", c.id);
    }
  });
  action("position", async (tx, c, l, row, user, body) => {
    const seconds = z.number().int().min(0).max(604800).parse(body.seconds);
    if (l.type !== "video" || body.revision !== revision(l))
      fail(409, "Видеоматериал изменился");
    await tx.query(
      "UPDATE course_lesson_progress SET position_seconds=$4,updated_at=NOW() WHERE course_id=$1 AND user_id=$2 AND lesson_id=$3",
      [c.id, user.id, l.id, seconds],
    );
  });
  action("quiz-start", async (tx, c, l, row, user, body) => {
    if (l.type !== "quiz" || body.revision !== revision(l))
      fail(409, "Тест изменился. Откройте его снова.");
    const now = Date.now(),
      duration = l.time_limit_minutes
        ? l.time_limit_minutes * 60000
        : 24 * 60 * 60000;
    if (
      row.active_attempt &&
      now < new Date(row.attempt_started_at).getTime() + duration
    )
      return {
        attempt: {
          id: row.active_attempt,
          expires_at: new Date(
            new Date(row.attempt_started_at).getTime() + duration,
          ).toISOString(),
          timed: Boolean(l.time_limit_minutes),
        },
      };
    if (l.attempt_limit && row.attempts >= l.attempt_limit)
      fail(409, "Доступные попытки закончились. Обратитесь к организатору.");
    const attemptId = randomUUID();
    await tx.query(
      "UPDATE course_lesson_progress SET active_attempt=$4,attempt_started_at=NOW(),attempts=attempts+1,updated_at=NOW() WHERE course_id=$1 AND user_id=$2 AND lesson_id=$3",
      [c.id, user.id, l.id, attemptId],
    );
    return {
      attempt: {
        id: attemptId,
        expires_at: new Date(now + duration).toISOString(),
        timed: Boolean(l.time_limit_minutes),
      },
    };
  });
  action("quiz-submit", async (tx, c, l, row, user, body) => {
    const input = z
      .object({
        attempt_id: uuid,
        revision: z.string().length(64),
        answers: z
          .array(z.object({ question_id: uuid, option_id: uuid }).strict())
          .max(30),
      })
      .strict()
      .parse(body);
    if (l.type !== "quiz" || input.revision !== revision(l))
      fail(409, "Тест изменился. Откройте его снова.");
    if (row.last_attempt === input.attempt_id && row.last_result)
      return { result: row.last_result };
    if (row.active_attempt !== input.attempt_id)
      fail(409, "Начните новую попытку теста");
    const answers = new Map(
      input.answers.map((a) => [a.question_id, a.option_id]),
    );
    if (
      answers.size !== l.questions.length ||
      input.answers.length !== l.questions.length ||
      l.questions.some(
        (q) => !q.options.some((o) => o.id === answers.get(q.id)),
      )
    )
      fail(400, "Ответьте на все вопросы");
    const expired =
      Date.now() >
      new Date(row.attempt_started_at).getTime() +
        (l.time_limit_minutes || 24 * 60) * 60000;
    const score = expired
      ? 0
      : l.questions.filter((q) => answers.get(q.id) === q.correct_option_id)
          .length;
    const result = {
      score,
      total: l.questions.length,
      passed: !expired && score >= l.pass_count,
      expired,
      feedback: l.questions.map((q) => ({
        question_id: q.id,
        correct: !expired && answers.get(q.id) === q.correct_option_id,
        explanation: q.explanation,
      })),
    };
    await tx.query(
      `UPDATE course_lesson_progress SET active_attempt=NULL,attempt_started_at=NULL,last_attempt=$4,last_result=$5,
      completed_at=CASE WHEN $6 THEN COALESCE(completed_at,NOW()) ELSE completed_at END,updated_at=NOW()
      WHERE course_id=$1 AND user_id=$2 AND lesson_id=$3`,
      [
        c.id,
        user.id,
        l.id,
        input.attempt_id,
        JSON.stringify(result),
        result.passed,
      ],
    );
    await audit(
      tx,
      user.id,
      result.passed ? "quiz_passed" : "quiz_attempt",
      "course",
      c.id,
    );
    return { result };
  });
}
module.exports = {
  registerCourseRoutes,
  publicationIssues,
  readLearningSummary,
};
