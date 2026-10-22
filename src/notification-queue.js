const INTERVAL_MS = 5000;
const BATCH_SIZE = 500;

function enqueueEventNotification(tx, event, audience = "volunteers") {
  if (!["volunteers", "applicants"].includes(audience))
    throw new Error("Invalid notification audience");
  return tx.query(
    `INSERT INTO notification_broadcasts(opportunity_id,audience,cutoff_user_id)
     VALUES($1,$2,COALESCE((SELECT MAX(id) FROM users),0))`,
    [event.id, audience],
  );
}

async function deliverBatch(db) {
  return db.transaction(async (tx) => {
    await tx.exec(
      "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'",
    );
    const lock = await tx.query(
      "SELECT pg_try_advisory_xact_lock(1145918281,10) AS acquired",
    );
    if (!lock.rows[0]?.acquired) return;
    // Keep the user/role lock order consistent with event and role mutations.
    await tx.query(
      "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
    );
    const { rows: jobs } = await tx.query(
      "SELECT * FROM notification_broadcasts WHERE status='pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!jobs.length) return;
    const job = jobs[0];
    const { rows: events } = await tx.query(
      "SELECT id,status,visibility,archived_at FROM opportunities WHERE id=$1 FOR SHARE SKIP LOCKED",
      [job.opportunity_id],
    );
    if (!events.length) return; // A writer is editing this event; retry next tick.
    const event = events[0];
    if (
      event.archived_at ||
      event.status === "draft" ||
      (job.audience === "volunteers" && event.status !== "open")
    ) {
      await tx.query(
        "UPDATE notification_broadcasts SET status='cancelled',completed_at=NOW() WHERE id=$1",
        [job.id],
      );
      return;
    }
    const { rows } = await tx.query(
      `SELECT u.id FROM users u WHERE u.id>$1 AND u.id<=$2
         AND u.role='volunteer' AND u.status IN ('new','active')
         AND ($3::text='volunteers' OR EXISTS (
           SELECT 1 FROM applications a WHERE a.user_id=u.id AND a.opportunity_id=$4 AND a.status IN ('pending','accepted')))
         AND ($5::text='public' OR EXISTS (
           SELECT 1 FROM opportunity_invitations i WHERE i.user_id=u.id AND i.opportunity_id=$4 AND i.status='active'))
       ORDER BY u.id LIMIT $6`,
      [
        job.cursor_user_id,
        job.cutoff_user_id,
        job.audience,
        event.id,
        event.visibility,
        BATCH_SIZE,
      ],
    );
    if (rows.length) {
      await tx.query(
        "INSERT INTO notifications(user_id,title,body) SELECT user_id,$2,$3 FROM unnest($1::bigint[]) AS recipients(user_id)",
        [
          rows.map((row) => row.id),
          job.audience === "volunteers"
            ? "Новая возможность участия"
            : "Изменения в мероприятии",
          job.audience === "volunteers"
            ? "Опубликовано новое мероприятие. Подробности — в разделе «Мероприятия»."
            : "Обновлено мероприятие, на которое вы откликнулись. Актуальная информация — в разделе «Мероприятия».",
        ],
      );
    }
    await tx.query(
      `UPDATE notification_broadcasts SET cursor_user_id=$2,delivered=delivered+$3,
         status=CASE WHEN $4 THEN 'completed' ELSE 'pending' END,
         completed_at=CASE WHEN $4 THEN NOW() ELSE NULL END WHERE id=$1`,
      [
        job.id,
        rows.at(-1)?.id || job.cutoff_user_id,
        rows.length,
        rows.length < BATCH_SIZE,
      ],
    );
  });
}

function startNotificationQueue(db) {
  let stopped = false;
  let active = null;
  const tick = () => {
    if (stopped || active) return;
    active = deliverBatch(db)
      .catch(() => {
        // Failed batches roll back cursor + inserts together and retry on next tick.
        console.error("Notification batch failed; will retry");
      })
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (active) await active;
  };
}

module.exports = { enqueueEventNotification, startNotificationQueue };
