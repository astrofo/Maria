const V = require("./validation");
const { courseAvailable } = require("./training-progress");

const pageSchema = V.z.coerce.number().int().min(1).max(100000);
const periodSchema = V.z
  .object({
    date_from: V.date.refine((value) => value >= "1900-01-01").optional(),
    date_to: V.date.refine((value) => value >= "1900-01-01").optional(),
  })
  .refine(
    (value) =>
      !value.date_from || !value.date_to || value.date_from <= value.date_to,
    "Начало периода должно быть не позже окончания",
  );

function registerReportingRoutes(app, { db, auth, requireRole, wrap, getOne }) {
  app.get(
    "/api/notifications/unread-count",
    auth,
    wrap(async (req, res) => {
      const { rows } = await db.query(
        "SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id=$1 AND read_at IS NULL",
        [req.user.id],
      );
      res.json({ unread: rows[0].unread });
    }),
  );
  app.get(
    "/api/notifications",
    auth,
    wrap(async (req, res) => {
      const page = pageSchema.parse(req.query.page ?? 1);
      const pageSize = V.z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(req.query.page_size ?? 50);
      const onlyUnread =
        V.z.enum(["true", "false"]).parse(req.query.unread ?? "false") ===
        "true";
      const result = await db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const { rows: counts } = await tx.query(
          `SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
           FROM notifications WHERE user_id=$1`,
          [req.user.id],
        );
        const { rows } = await tx.query(
          `SELECT * FROM notifications WHERE user_id=$1
             AND ($2::boolean=false OR read_at IS NULL)
           ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
          [req.user.id, onlyUnread, pageSize, (page - 1) * pageSize],
        );
        const total = onlyUnread ? counts[0].unread : counts[0].total;
        return {
          items: rows,
          unread: counts[0].unread,
          total,
          page,
          page_size: pageSize,
          pages: Math.max(1, Math.ceil(total / pageSize)),
        };
      });
      res.json(result);
    }),
  );
  app.patch(
    "/api/notifications/:id/read",
    auth,
    wrap(async (req, res) => {
      const item = await getOne(
        db,
        "UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING *",
        [V.id.parse(req.params.id), req.user.id],
      );
      res.json({ item });
    }),
  );
  app.post(
    "/api/notifications/read-all",
    auth,
    wrap(async (req, res) => {
      const { rows } = await db.query(
        `WITH marked AS (
           UPDATE notifications SET read_at=NOW()
           WHERE user_id=$1 AND read_at IS NULL RETURNING id
         ) SELECT COUNT(*)::int AS marked FROM marked`,
        [req.user.id],
      );
      res.json({ marked: rows[0].marked });
    }),
  );
  app.get(
    "/api/analytics",
    requireRole("manager"),
    wrap(async (req, res) => {
      const period = periodSchema.parse(req.query);
      const params = [period.date_from ?? null, period.date_to ?? null];
      const result = await db.transaction(async (tx) => {
        await tx.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        await tx.query("SET LOCAL TIME ZONE 'UTC'");
        await tx.query("SET LOCAL statement_timeout = '15s'");
        const users = await tx.query(
          "SELECT role,status,COUNT(*)::int AS count FROM users GROUP BY role,status ORDER BY role,status",
        );
        const hours = await tx.query(
          `SELECT COALESCE(SUM(hours),0) AS total_hours,COUNT(*)::int AS entries,
             COUNT(DISTINCT user_id)::int AS volunteers
           FROM participation
           WHERE ($1::date IS NULL OR participated_on >= $1::date)
             AND ($2::date IS NULL OR participated_on <= $2::date)`,
          params,
        );
        const registrations = await tx.query(
          `SELECT date_trunc('month',created_at)::date AS month,COUNT(*)::int AS count
           FROM users WHERE role='volunteer'
             AND ($1::date IS NULL OR created_at >= $1::date)
             AND ($2::date IS NULL OR created_at < $2::date + INTERVAL '1 day')
             AND ($1::date IS NOT NULL OR $2::date IS NOT NULL OR created_at >= NOW()-INTERVAL '12 months')
           GROUP BY 1 ORDER BY 1`,
          params,
        );
        const cities = await tx.query(
          "SELECT COALESCE(NULLIF(city,''),'Не указан') AS city,COUNT(*)::int AS count FROM users WHERE role='volunteer' GROUP BY 1 ORDER BY count DESC,city LIMIT 20",
        );
        const opportunities = await tx.query(
          `SELECT status,COUNT(*)::int AS count FROM opportunities
           WHERE archived_at IS NULL AND ($1::date IS NULL OR starts_at >= $1::date)
             AND ($2::date IS NULL OR starts_at < $2::date + INTERVAL '1 day')
           GROUP BY status ORDER BY status`,
          params,
        );
        const monthlyActivity = await tx.query(
          `SELECT date_trunc('month',participated_on)::date AS month,
             COALESCE(SUM(hours),0) AS total_hours,COUNT(*)::int AS entries,
             COUNT(DISTINCT user_id)::int AS volunteers
           FROM participation
           WHERE ($1::date IS NULL OR participated_on >= $1::date)
             AND ($2::date IS NULL OR participated_on <= $2::date)
           GROUP BY 1 ORDER BY 1`,
          params,
        );
        const onboarding = await tx.query(
          `SELECT COUNT(*)::int AS volunteers,
             COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS email_verified,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM volunteer_questionnaires q WHERE q.user_id=u.id AND q.completed_at IS NOT NULL
             ))::int AS questionnaire_completed,
             COUNT(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM training_materials m WHERE m.required AND m.published
                 AND NOT EXISTS (SELECT 1 FROM training_completions c WHERE c.user_id=u.id AND c.material_id=m.id)
             ) AND NOT EXISTS (
               SELECT 1 FROM courses c CROSS JOIN LATERAL jsonb_array_elements(c.document->'lessons') lesson
               WHERE ${courseAvailable()} AND (c.document->>'required')::boolean
                 AND NOT EXISTS (
                   SELECT 1 FROM course_lesson_progress p WHERE p.user_id=u.id AND p.course_id=c.id
                     AND p.lesson_id=lesson->>'id' AND p.content_hash=lesson->>'content_hash'
                     AND p.completed_at IS NOT NULL
                 )
             ))::int AS required_training_completed
           FROM users u WHERE u.role='volunteer' AND u.status<>'closed'`,
        );
        const requiredTraining = await tx.query(
          "SELECT COUNT(*)::int AS count FROM training_materials WHERE required AND published",
        );
        const requiredCourses = await tx.query(
          `SELECT COUNT(*)::int AS courses,COALESCE(SUM(jsonb_array_length(c.document->'lessons')),0)::int AS lessons
           FROM courses c WHERE c.status='published' AND c.archived_at IS NULL AND (c.document->>'required')::boolean
             AND (c.document->>'starts_at' IS NULL OR (c.document->>'starts_at')::timestamptz<=NOW())
             AND (c.document->>'ends_at' IS NULL OR (c.document->>'ends_at')::timestamptz>NOW())`,
        );
        return {
          users: users.rows,
          hours: hours.rows[0],
          registrations: registrations.rows,
          cities: cities.rows,
          opportunities: opportunities.rows,
          monthly_activity: monthlyActivity.rows,
          onboarding: {
            ...onboarding.rows[0],
            required_materials:
              requiredTraining.rows[0].count + requiredCourses.rows[0].lessons,
            legacy_required_materials: requiredTraining.rows[0].count,
            required_courses: requiredCourses.rows[0].courses,
            required_course_lessons: requiredCourses.rows[0].lessons,
          },
          period: { date_from: params[0], date_to: params[1], timezone: "UTC" },
        };
      });
      res.json(result);
    }),
  );
}

module.exports = { registerReportingRoutes };
