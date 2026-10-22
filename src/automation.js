const { id } = require("./validation");

const INTERVAL_MS = 60000;
const ACHIEVEMENTS = Object.freeze([
  {
    key: "first_activity",
    title: "Первое участие",
    description: "Первое подтверждённое участие в волонтёрской работе",
    threshold: 1,
    unit: "activities",
  },
  ...[10, 50, 100].map((hours) => ({
    key: `${hours}h`,
    title: `${hours} часов помощи`,
    description: `${hours} подтверждённых часов волонтёрской работы`,
    threshold: hours,
    unit: "hours",
  })),
]);

const eventKey = `('event:' || o.id::text || ':' ||
  (EXTRACT(EPOCH FROM o.starts_at) * 1000000)::bigint::text || ':' ||
  CASE WHEN o.starts_at <= NOW() + INTERVAL '2 hours' THEN '2h' ELSE '24h' END ||
  ':user:' || a.user_id::text)`;
const eventEligibility = `a.status='accepted' AND u.role='volunteer'
  AND u.status IN ('new','active') AND (
    o.visibility='public' OR EXISTS (
      SELECT 1 FROM opportunity_invitations i
      WHERE i.opportunity_id=o.id AND i.user_id=a.user_id AND i.status='active'
    )
  )`;

// Reserve all keys and create their notifications atomically. An already delivered
// key stays in the ledger even if hours are corrected or a notification is removed.
async function notifyOnce(tx, candidates) {
  const unique = [
    ...new Map(candidates.map((item) => [item.event_key, item])).values(),
  ];
  if (!unique.length) return 0;
  const { rows } = await tx.query(
    `WITH candidates AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS c(event_key TEXT,kind TEXT,user_id BIGINT,title TEXT,body TEXT)
    ), reserved AS (
      INSERT INTO automation_ledger(event_key,kind,user_id)
      SELECT event_key,kind,user_id FROM candidates
      ON CONFLICT(event_key) DO NOTHING RETURNING event_key
    )
    INSERT INTO notifications(user_id,title,body)
    SELECT c.user_id,c.title,c.body FROM candidates c
      JOIN reserved r ON r.event_key=c.event_key RETURNING id`,
    [JSON.stringify(unique)],
  );
  return rows.length;
}

async function remindEvents(tx) {
  // Event mutations, applications and invitation changes use the same event lock.
  // Skip rows another request is editing; a later tick will reconsider them.
  const locked = await tx.query(
    `SELECT o.id FROM opportunities o
    WHERE o.archived_at IS NULL AND o.status='open' AND o.starts_at>NOW()
      AND o.starts_at<=NOW()+INTERVAL '24 hours'
      AND EXISTS (
        SELECT 1 FROM applications a JOIN users u ON u.id=a.user_id
        WHERE a.opportunity_id=o.id AND ${eventEligibility}
          AND NOT EXISTS (SELECT 1 FROM automation_ledger l WHERE l.event_key=${eventKey})
      )
    ORDER BY o.starts_at,o.id LIMIT 100 FOR UPDATE OF o SKIP LOCKED`,
  );
  if (!locked.rows.length) return 0;
  // Recheck eligibility after taking the event locks. The key includes starts_at,
  // so a rescheduled event may issue a reminder for its new date.
  const { rows } = await tx.query(
    `SELECT a.user_id,o.id AS opportunity_id,${eventKey} AS event_key,
      ('reminder:' || o.id::text || ':' ||
        (EXTRACT(EPOCH FROM o.starts_at) * 1000000)::bigint::text || ':' ||
        CASE WHEN o.starts_at<=NOW()+INTERVAL '2 hours' THEN '2h' ELSE '24h' END) AS group_key,
      CASE WHEN o.starts_at<=NOW()+INTERVAL '2 hours' THEN '2h' ELSE '24h' END AS reminder_window
    FROM opportunities o JOIN applications a ON a.opportunity_id=o.id
      JOIN users u ON u.id=a.user_id
    WHERE o.id=ANY($1::bigint[]) AND o.archived_at IS NULL AND o.status='open' AND o.starts_at>NOW()
      AND o.starts_at<=NOW()+INTERVAL '24 hours' AND ${eventEligibility}
      AND NOT EXISTS (SELECT 1 FROM automation_ledger l WHERE l.event_key=${eventKey})
    ORDER BY o.starts_at,o.id,a.user_id LIMIT 500`,
    [locked.rows.map((row) => row.id)],
  );
  // Personal reminders are batched by recipient. The group gets one shared
  // announcement for the same date/window, even when delivery spans many ticks.
  const announcements = [
    ...new Map(
      rows.map((row) => [
        row.group_key,
        {
          opportunity_id: row.opportunity_id,
          source_key: row.group_key,
          body: `Напоминание: мероприятие начнётся в течение ${row.reminder_window === "2h" ? "2 часов" : "24 часов"}. Проверьте время и место в карточке встречи.`,
        },
      ]),
    ).values(),
  ];
  if (announcements.length) {
    await tx.query(
      `SELECT append_group_system_message(opportunity_id,source_key,body)
       FROM jsonb_to_recordset($1::jsonb)
         AS announcement(opportunity_id BIGINT,source_key TEXT,body TEXT)`,
      [JSON.stringify(announcements)],
    );
  }
  return notifyOnce(
    tx,
    rows.map((row) => ({
      event_key: row.event_key,
      kind: "event_reminder",
      user_id: row.user_id,
      title: "Скоро мероприятие",
      // No private event details remain in notifications after permissions change.
      body: `Мероприятие, на которое подтверждено ваше участие, начнётся в течение ${row.reminder_window === "2h" ? "2 часов" : "24 часов"}. Подробности — в разделе «Возможности».`,
    })),
  );
}

async function remindTasks(tx) {
  const key = `('task:' || t.id::text || ':' ||
    (EXTRACT(EPOCH FROM t.due_at) * 1000000)::bigint::text ||
    ':assignee:' || t.assigned_to::text)`;
  const { rows } = await tx.query(
    `SELECT t.id,t.assigned_to AS user_id,${key} AS event_key
    FROM staff_tasks t JOIN users assignee ON assignee.id=t.assigned_to
      JOIN users volunteer ON volunteer.id=t.user_id
    WHERE t.status IN ('open','in_progress') AND t.due_at<=NOW()
      AND assignee.role IN ('coordinator','manager','admin') AND assignee.status='active'
      AND volunteer.role='volunteer'
      AND NOT EXISTS (SELECT 1 FROM automation_ledger l WHERE l.event_key=${key})
    ORDER BY t.due_at,t.id LIMIT 200 FOR UPDATE OF t SKIP LOCKED`,
  );
  // Assignment itself gives a coordinator access to the task. Reassignment uses
  // a new recipient key, allowing the newly responsible person one reminder.
  return notifyOnce(
    tx,
    rows.map((row) => ({
      event_key: row.event_key,
      kind: "task_due",
      user_id: row.user_id,
      title: "Срок задачи истёк",
      body: `Истёк срок задачи №${row.id}.`,
    })),
  );
}

async function notifyAchievements(tx) {
  const pending = await tx.query(
    `SELECT user_id FROM achievement_recheck_queue WHERE check_after<=NOW()
     ORDER BY check_after,user_id LIMIT 100 FOR UPDATE SKIP LOCKED`,
  );
  if (!pending.rows.length) return 0;
  const userIds = pending.rows.map((row) => row.user_id);
  const { rows } = await tx.query(
    `WITH progress AS (
      SELECT u.id AS user_id,COUNT(*)::int AS activities,SUM(p.hours) AS hours
      FROM users u JOIN participation p ON p.user_id=u.id
      WHERE u.id=ANY($1::bigint[]) AND u.role='volunteer' AND u.status<>'closed'
        AND p.hours>0 AND p.participated_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
      GROUP BY u.id
    ), definitions AS (
      SELECT * FROM (VALUES ('first_activity',1,'activities'),
        ('10h',10,'hours'),('50h',50,'hours'),('100h',100,'hours')) AS d(key,threshold,unit)
    )
    SELECT p.user_id,d.key,('achievement:'||p.user_id::text||':'||d.key) AS event_key
    FROM progress p CROSS JOIN definitions d
    WHERE CASE WHEN d.unit='activities' THEN p.activities ELSE p.hours END >= d.threshold
      AND NOT EXISTS (SELECT 1 FROM automation_ledger l
        WHERE l.event_key=('achievement:'||p.user_id::text||':'||d.key))
    ORDER BY p.user_id,d.threshold,d.key`,
    [userIds],
  );
  const delivered = await notifyOnce(
    tx,
    rows.map((row) => {
      const definition = ACHIEVEMENTS.find((item) => item.key === row.key);
      return {
        event_key: row.event_key,
        kind: "achievement",
        user_id: row.user_id,
        title: `Новое достижение: ${definition.title}`,
        body: "Достижение получено по подтверждённым записям участия.",
      };
    }),
  );
  await tx.query(
    "DELETE FROM achievement_recheck_queue WHERE user_id=ANY($1::bigint[])",
    [userIds],
  );
  // A future-dated participation becomes eligible at midnight UTC even without
  // another edit. Recheck only users who actually have such a future record.
  await tx.query(
    `INSERT INTO achievement_recheck_queue(user_id,check_after)
     SELECT p.user_id,MIN(p.participated_on)::timestamp AT TIME ZONE 'UTC'
     FROM participation p JOIN users u ON u.id=p.user_id
     WHERE p.user_id=ANY($1::bigint[]) AND u.role='volunteer' AND u.status<>'closed'
       AND p.hours>0 AND p.participated_on>(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
     GROUP BY p.user_id
     ON CONFLICT(user_id) DO UPDATE SET check_after=LEAST(achievement_recheck_queue.check_after,EXCLUDED.check_after)`,
    [userIds],
  );
  return delivered;
}

function safeFailure(error) {
  if (["40001", "40P01", "55P03", "57014"].includes(error?.code))
    return "database_busy";
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "57P01",
      "57P02",
      "57P03",
    ].includes(error?.code) ||
    (typeof error?.code === "string" && /^08[0-9A-Z]{3}$/.test(error.code))
  )
    return "database_unavailable";
  return "automation_failed";
}

async function runAutomation(db) {
  try {
    return await db.transaction(async (tx) => {
      await tx.exec(
        "SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'",
      );
      const lock = await tx.query(
        "SELECT pg_try_advisory_xact_lock(1145918281,7) AS acquired",
      );
      if (!lock.rows[0]?.acquired) return { ok: true, skipped: true };
      // Role/status mutations first lock current admins FOR UPDATE. Use the same
      // order without locking all volunteer rows, keeping eligibility current.
      await tx.query(
        "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
      );

      const counts = {
        event_reminders: await remindEvents(tx),
        task_reminders: await remindTasks(tx),
        achievements: await notifyAchievements(tx),
        expired_sessions: 0,
      };
      const expired = await tx.query(
        `WITH expired AS (
          SELECT sid FROM sessions WHERE expires_at<NOW()
          ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
        ) DELETE FROM sessions s USING expired e WHERE s.sid=e.sid RETURNING s.sid`,
      );
      counts.expired_sessions = expired.rows.length;
      await tx.query(
        `INSERT INTO automation_state(name,last_attempt_at,last_success_at,success_count,last_counts)
        VALUES('main',CLOCK_TIMESTAMP(),CLOCK_TIMESTAMP(),1,$1::jsonb)
        ON CONFLICT(name) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
          last_success_at=EXCLUDED.last_success_at,success_count=automation_state.success_count+1,
          last_counts=EXCLUDED.last_counts`,
        [JSON.stringify(counts)],
      );
      return { ok: true, skipped: false, counts };
    });
  } catch (error) {
    const code = safeFailure(error);
    // This runs after rollback. Never persist/log driver messages, SQL or data.
    try {
      await db.query(
        `INSERT INTO automation_state(name,last_attempt_at,last_failure_at,last_failure_code,failure_count)
        VALUES('main',CLOCK_TIMESTAMP(),CLOCK_TIMESTAMP(),$1,1)
        ON CONFLICT(name) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
          last_failure_at=EXCLUDED.last_failure_at,last_failure_code=EXCLUDED.last_failure_code,
          failure_count=automation_state.failure_count+1`,
        [code],
      );
    } catch {
      /* Database may be unavailable; retry on the next scheduled tick. */
    }
    return { ok: false, code };
  }
}

function startAutomation({ db, intervalMs = INTERVAL_MS }) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > 3600000
  )
    throw new Error(
      "Automation interval must be between 1000 and 3600000 milliseconds",
    );
  let stopped = false;
  let active = null;
  const tick = () => {
    if (stopped || active) return active;
    active = runAutomation(db).finally(() => {
      active = null;
    });
    return active;
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();
  return async function stopAutomation() {
    stopped = true;
    clearInterval(timer);
    if (active) await active;
  };
}

async function achievementProgress(db, userId) {
  const { rows } = await db.query(
    `SELECT u.id,u.role,COUNT(p.id)::int AS activities,COALESCE(SUM(p.hours),0) AS total_hours
    FROM users u LEFT JOIN participation p ON p.user_id=u.id
      AND p.hours>0 AND p.participated_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    WHERE u.id=$1 GROUP BY u.id,u.role`,
    [userId],
  );
  if (!rows.length) return null;
  const row = rows[0];
  const volunteer = row.role === "volunteer";
  const totalHours = volunteer ? Number(row.total_hours) : 0;
  const activities = volunteer ? Number(row.activities) : 0;
  return {
    role: row.role,
    data: {
      user_id: row.id,
      total_hours: totalHours,
      activities,
      items: volunteer
        ? ACHIEVEMENTS.map((definition) => {
            const value = definition.unit === "hours" ? totalHours : activities;
            return {
              ...definition,
              progress: Math.min(value, definition.threshold),
              earned: value >= definition.threshold,
            };
          })
        : [],
    },
  };
}

function registerAutomationRoutes(app, { db, auth, requireRole, wrap }) {
  app.get(
    "/api/achievements",
    auth,
    wrap(async (req, res) => {
      const progress = await achievementProgress(db, req.user.id);
      if (!progress)
        return res.status(404).json({ error: "Пользователь не найден" });
      res.set("Cache-Control", "no-store").json(progress.data);
    }),
  );
  app.get(
    "/api/users/:id/achievements",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const userId = id.parse(req.params.id);
      const progress = await achievementProgress(db, userId);
      if (!progress)
        return res.status(404).json({ error: "Пользователь не найден" });
      if (req.user.role === "coordinator" && progress.role !== "volunteer")
        return res.status(403).json({ error: "Недостаточно прав" });
      res.set("Cache-Control", "no-store").json(progress.data);
    }),
  );
  app.get(
    "/api/admin/automation",
    requireRole("admin"),
    wrap(async (_req, res) => {
      const { rows } = await db.query(
        `SELECT last_attempt_at,last_success_at,last_failure_at,last_failure_code,
        success_count,failure_count,last_counts FROM automation_state WHERE name='main'`,
      );
      const state = rows[0] || {
        last_attempt_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        success_count: 0,
        failure_count: 0,
        last_counts: {},
      };
      const { rows: broadcasts } = await db.query(
        `SELECT COUNT(*) FILTER(WHERE status='pending')::int AS pending,
          MIN(created_at) FILTER(WHERE status='pending') AS oldest_pending_at,
          COALESCE(SUM(delivered),0) AS delivered FROM notification_broadcasts`,
      );
      res.set("Cache-Control", "no-store").json({
        interval_ms: INTERVAL_MS,
        ...state,
        notification_queue: {
          interval_ms: 5000,
          batch_size: 500,
          ...broadcasts[0],
        },
      });
    }),
  );
}

module.exports = { startAutomation, runAutomation, registerAutomationRoutes };
