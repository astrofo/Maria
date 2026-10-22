const { z, id } = require("./validation");

const STAFF_ROLES = new Set(["coordinator", "manager", "admin"]);
const PAGE_SIZE = 50;
const priority = z.enum(["low", "normal", "high"]);
const status = z.enum(["open", "in_progress", "done", "cancelled"]);
const dueAt = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Некорректный срок задачи",
  )
  .transform((value) => new Date(value).toISOString());
const taskFields = {
  user_id: id,
  assigned_to: id,
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000),
  due_at: dueAt.nullable(),
  priority,
};
const createSchema = z
  .object({
    ...taskFields,
    description: taskFields.description.default(""),
    due_at: taskFields.due_at.default(null),
    priority: priority.default("normal"),
  })
  .strict();
const patchSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(taskFields).map(([key, schema]) => [
        key,
        schema.optional(),
      ]),
    ),
    status: status.optional(),
    expected_version: z.number().int().positive().max(2147483647),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "expected_version"),
    "Укажите хотя бы одно изменяемое поле задачи",
  );
const queryFlag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");
const listSchema = z
  .object({
    mine: queryFlag.optional().default("false"),
    user_id: id.optional(),
    status: status.optional(),
    overdue: queryFlag.optional().default("false"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();

const sameId = (a, b) => String(a) === String(b);
const managesTasks = (actor) =>
  actor.role === "manager" || actor.role === "admin";
const fail = (statusCode, message, code) => {
  throw Object.assign(new Error(message), {
    status: statusCode,
    ...(code ? { code } : {}),
  });
};

const selectTask = `SELECT t.*, volunteer.full_name AS user_name,
  assignee.full_name AS assigned_to_name, creator.full_name AS created_by_name,
  (t.status IN ('open','in_progress') AND t.due_at IS NOT NULL AND t.due_at < NOW()) AS is_overdue
  FROM staff_tasks t
  JOIN users volunteer ON volunteer.id=t.user_id
  JOIN users assignee ON assignee.id=t.assigned_to
  JOIN users creator ON creator.id=t.created_by`;

// This predicate is shared by scoped reads and the row lock. Inaccessible IDs
// return the same 404 response as missing records.
const accessPredicate = `($1::boolean OR (
  volunteer.role='volunteer' AND (t.created_by=$2 OR t.assigned_to=$2)
))`;

async function scopedTask(tx, taskId, actor, lock = false) {
  const { rows } = await tx.query(
    `${selectTask} WHERE ${accessPredicate} AND t.id=$3${lock ? " FOR UPDATE OF t" : ""}`,
    [managesTasks(actor), actor.id, taskId],
  );
  if (!rows[0]) fail(404, "Задача не найдена");
  return rows[0];
}

async function lockActor(tx, requestUser) {
  // The role/status routes lock all administrators before another user. Keep
  // that order here so assigning an administrator cannot deadlock with them.
  await tx.query(
    "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
  );
  const { rows } = await tx.query(
    "SELECT id,role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
    [requestUser.id],
  );
  const actor = rows[0];
  if (
    !actor ||
    !STAFF_ROLES.has(actor.role) ||
    actor.status === "closed" ||
    actor.auth_version !== requestUser.auth_version
  )
    fail(403, "Права доступа изменились. Войдите в аккаунт снова.");
  return actor;
}

async function lockRelatedUsers(tx, userIds) {
  const ids = [...new Set(userIds.map(String))];
  const { rows } = await tx.query(
    "SELECT id,role,status FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE",
    [ids],
  );
  return new Map(rows.map((user) => [String(user.id), user]));
}

function validateRelatedUsers(users, task) {
  const volunteer = users.get(String(task.user_id));
  if (!volunteer || volunteer.role !== "volunteer")
    fail(400, "Выберите существующего волонтёра для задачи.");
  const assignee = users.get(String(task.assigned_to));
  if (
    !assignee ||
    !STAFF_ROLES.has(assignee.role) ||
    assignee.status !== "active"
  )
    fail(
      400,
      "Исполнителем может быть только сотрудник со статусом «Активен».",
    );
}

async function notifyAssignment(tx, notify, task) {
  // Notifications remain visible after later role changes. Keep names, the
  // task title and private case details out of this general-purpose channel.
  await notify(
    tx,
    task.assigned_to,
    "Вам назначена задача команды",
    `Номер задачи: ${task.id}.`,
  );
}

function registerStaffTaskRoutes(
  app,
  { db, auth, requireRole, wrap, audit, notify },
) {
  const route = (handler) =>
    wrap(async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        // The general app error handler deliberately only exposes error text.
        // This conflict code allows a client to reload instead of overwriting.
        if (error.code === "TASK_VERSION_CONFLICT")
          return res
            .status(409)
            .json({ error: error.message, code: error.code });
        throw error;
      }
    });

  app.get(
    "/api/staff-tasks",
    auth,
    requireRole("coordinator"),
    route(async (req, res) => {
      const filters = listSchema.parse(req.query);
      const values = [
        managesTasks(req.user),
        req.user.id,
        filters.mine,
        filters.user_id ?? null,
        filters.status ?? null,
        filters.overdue,
      ];
      const where = `WHERE ${accessPredicate}
      AND (NOT $3::boolean OR t.assigned_to=$2)
      AND ($4::bigint IS NULL OR t.user_id=$4)
      AND ($5::text IS NULL OR t.status=$5)
      AND (NOT $6::boolean OR (t.status IN ('open','in_progress') AND t.due_at < NOW()))`;
      const count = await db.query(
        `SELECT COUNT(*)::int AS count FROM staff_tasks t JOIN users volunteer ON volunteer.id=t.user_id ${where}`,
        values,
      );
      const { rows } = await db.query(
        `${selectTask} ${where}
       ORDER BY CASE WHEN t.status IN ('open','in_progress') THEN 0 ELSE 1 END,
         CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         t.due_at ASC NULLS LAST,t.created_at DESC,t.id DESC LIMIT 50 OFFSET $7`,
        [...values, (filters.page - 1) * PAGE_SIZE],
      );
      const total = Number(count.rows[0].count);
      res.json({
        items: rows,
        page: filters.page,
        page_size: PAGE_SIZE,
        total,
        pages: Math.ceil(total / PAGE_SIZE),
      });
    }),
  );

  app.get(
    "/api/staff-tasks/:id",
    auth,
    requireRole("coordinator"),
    route(async (req, res) => {
      const item = await scopedTask(db, id.parse(req.params.id), req.user);
      res.json({ item });
    }),
  );

  app.post(
    "/api/staff-tasks",
    auth,
    requireRole("coordinator"),
    route(async (req, res) => {
      const input = createSchema.parse(req.body);
      const item = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        if (!managesTasks(actor) && !sameId(input.assigned_to, actor.id))
          fail(403, "Координатор может назначить задачу только себе.");
        const related = await lockRelatedUsers(tx, [
          input.user_id,
          input.assigned_to,
        ]);
        validateRelatedUsers(related, input);
        const { rows } = await tx.query(
          `INSERT INTO staff_tasks(user_id,assigned_to,created_by,title,description,due_at,priority)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            input.user_id,
            input.assigned_to,
            actor.id,
            input.title,
            input.description,
            input.due_at,
            input.priority,
          ],
        );
        const task = await scopedTask(tx, rows[0].id, actor);
        await audit(tx, actor.id, "create_staff_task", "staff_task", task.id);
        await notifyAssignment(tx, notify, task);
        return task;
      });
      res.status(201).json({ item });
    }),
  );

  app.patch(
    "/api/staff-tasks/:id",
    auth,
    requireRole("coordinator"),
    route(async (req, res) => {
      const taskId = id.parse(req.params.id);
      const input = patchSchema.parse(req.body);
      const item = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const old = await scopedTask(tx, taskId, actor, true);
        if (Number(old.version) !== input.expected_version)
          fail(
            409,
            "Задача уже изменена. Обновите её и повторите действие.",
            "TASK_VERSION_CONFLICT",
          );
        const next = { ...old, ...input };
        const reassigned = !sameId(next.assigned_to, old.assigned_to);
        if (
          !managesTasks(actor) &&
          reassigned &&
          !sameId(next.assigned_to, actor.id)
        )
          fail(403, "Координатор может переназначить задачу только себе.");
        const related = await lockRelatedUsers(tx, [
          old.user_id,
          old.assigned_to,
          next.user_id,
          next.assigned_to,
        ]);
        if (
          !managesTasks(actor) &&
          related.get(String(old.user_id))?.role !== "volunteer"
        )
          fail(404, "Задача не найдена");
        validateRelatedUsers(related, next);
        if (Number(old.version) >= 2147483647)
          fail(
            409,
            "Задача достигла предела изменений. Создайте новую задачу.",
          );
        await tx.query(
          `UPDATE staff_tasks SET user_id=$1,assigned_to=$2,title=$3,description=$4,due_at=$5,
          priority=$6,status=$7,
          completed_at=CASE WHEN $7='done' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
          version=version+1,updated_at=NOW() WHERE id=$8`,
          [
            next.user_id,
            next.assigned_to,
            next.title,
            next.description,
            next.due_at,
            next.priority,
            next.status,
            taskId,
          ],
        );
        const task = await scopedTask(tx, taskId, actor);
        await audit(tx, actor.id, "update_staff_task", "staff_task", task.id);
        if (reassigned) await notifyAssignment(tx, notify, task);
        return task;
      });
      res.json({ item });
    }),
  );
}

module.exports = { registerStaffTaskRoutes };
