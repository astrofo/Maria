const rateLimit = require("express-rate-limit");
const V = require("./validation");
const { pagination, queryPage } = require("./pagination");
const { z } = V;
const same = (a, b) => String(a) === String(b);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const messageSchema = z
  .object({
    body: V.text(4000).min(1),
    client_id: z.string().uuid(),
    kind: z.enum(["message", "announcement"]).default("message"),
  })
  .strict();

// One predicate governs lists, history, membership, direct messages and unread counts.
// Never cache membership: withdrawals and invitation revocations take effect immediately.
const organizerSQL = (u) => `COALESCE((${u}.role IN ('manager','admin') OR
  (${u}.role='coordinator' AND (${u}.id=o.coordinator_id OR ${u}.id=o.created_by))),false)`;
const memberSQL = (u) => `(${u}.status<>'closed' AND (${organizerSQL(u)} OR
  (o.status<>'draft' AND EXISTS(SELECT 1 FROM applications a WHERE a.opportunity_id=o.id
    AND a.user_id=${u}.id AND a.status='accepted') AND (o.visibility='public' OR
    EXISTS(SELECT 1 FROM opportunity_invitations i WHERE i.opportunity_id=o.id
      AND i.user_id=${u}.id AND i.status='active')))))`;
const groupFrom = `FROM group_threads g JOIN opportunities o ON o.id=g.opportunity_id
  JOIN users actor ON actor.id=$1
  LEFT JOIN users peer ON peer.id=CASE WHEN g.user_low_id=$1 THEN g.user_high_id ELSE g.user_low_id END`;
const accessible = `${memberSQL("actor")} AND (g.kind='event' OR
  (($1=g.user_low_id OR $1=g.user_high_id) AND ${memberSQL("peer")}))`;
const groupFields = `g.id,g.kind,g.opportunity_id,o.title AS opportunity_title,
  CASE WHEN g.kind='direct' THEN peer.full_name ELSE o.title END AS title,
  (o.status<>'open' OR o.archived_at IS NOT NULL) AS read_only,
  (g.kind='event' AND ${organizerSQL("actor")} AND o.status='open' AND o.archived_at IS NULL) AS can_announce,
  CASE WHEN g.kind='direct' THEN json_build_object('id',peer.id,'full_name',peer.full_name,'role',peer.role) END AS peer,
  (SELECT count(*)::int FROM group_messages m WHERE m.group_id=g.id
    AND m.sender_user_id IS DISTINCT FROM $1 AND m.id>COALESCE((SELECT last_read_id FROM group_reads r
      WHERE r.group_id=g.id AND r.user_id=$1),0)) AS unread,
  (SELECT m.created_at FROM group_messages m WHERE m.group_id=g.id ORDER BY m.id DESC LIMIT 1) AS last_message_at,
  (SELECT json_build_object('id',m.id,'body',m.body,'kind',m.kind,'created_at',m.created_at,
    'sender_name',CASE WHEN m.kind='system' THEN 'Система' ELSE COALESCE(s.full_name,'Участник') END)
    FROM group_messages m LEFT JOIN users s ON s.id=m.sender_user_id
    WHERE m.group_id=g.id ORDER BY m.id DESC LIMIT 1) AS last_message`;
const messageFields = `m.id,m.group_id,m.sender_user_id,m.kind,m.body,m.created_at,
  CASE WHEN m.kind='system' THEN 'Система' ELSE COALESCE(u.full_name,'Участник') END AS sender_name,
  u.role AS sender_role,COALESCE(m.sender_user_id=$2,false) AS is_mine`;

async function lockActor(tx, requestUser) {
  if (!requestUser) fail(401, "Войдите в аккаунт");
  // Match the role/status mutation order used by the rest of the monolith.
  await tx.query(
    "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
  );
  const { rows } = await tx.query(
    "SELECT id,full_name,role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
    [requestUser.id],
  );
  const actor = rows[0];
  if (
    !actor ||
    actor.status === "closed" ||
    actor.auth_version !== requestUser.auth_version
  )
    fail(401, "Сессия завершена. Войдите снова.");
  return actor;
}

async function groupItem(tx, groupId, actorId) {
  const { rows } = await tx.query(
    `SELECT ${groupFields} ${groupFrom} WHERE g.id=$2 AND ${accessible}`,
    [actorId, groupId],
  );
  if (!rows[0]) fail(404, "Разговор недоступен");
  return rows[0];
}

async function lockGroup(tx, id, actor, write = false) {
  const { rows } = await tx.query("SELECT * FROM group_threads WHERE id=$1", [
    id,
  ]);
  const thread = rows[0];
  if (!thread) fail(404, "Разговор недоступен");
  // Applications, invitations and archive operations lock the same event first.
  await tx.query("SELECT id FROM opportunities WHERE id=$1 FOR SHARE", [
    thread.opportunity_id,
  ]);
  if (thread.kind === "direct") {
    if (
      ![thread.user_low_id, thread.user_high_id].some((value) =>
        same(value, actor.id),
      )
    )
      fail(404, "Разговор недоступен");
    const peerId = same(thread.user_low_id, actor.id)
      ? thread.user_high_id
      : thread.user_low_id;
    await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [peerId]);
  }
  await tx.query(
    `SELECT id FROM group_threads WHERE id=$1 FOR ${write ? "UPDATE" : "SHARE"}`,
    [id],
  );
  return groupItem(tx, id, actor.id);
}

async function markRead(tx, groupId, actorId, messageId) {
  const { rows } = await tx.query(
    "SELECT id FROM group_messages WHERE group_id=$1 AND id=$2",
    [groupId, messageId],
  );
  if (!rows[0]) fail(404, "Сообщение не найдено");
  await tx.query(
    `INSERT INTO group_reads(group_id,user_id,last_read_id) VALUES($1,$2,$3)
    ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=GREATEST(group_reads.last_read_id,EXCLUDED.last_read_id),updated_at=NOW()`,
    [groupId, actorId, messageId],
  );
}

async function unreadCount(tx, actorId) {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS unread ${groupFrom}
    JOIN group_messages m ON m.group_id=g.id
    LEFT JOIN group_reads r ON r.group_id=g.id AND r.user_id=$1
    WHERE ${accessible} AND m.sender_user_id IS DISTINCT FROM $1 AND m.id>COALESCE(r.last_read_id,0)`,
    [actorId],
  );
  return rows[0].unread;
}

function registerGroupMessagingRoutes(app, { db, auth, wrap, audit }) {
  const limit = (amount, windowMs) =>
    rateLimit({
      windowMs,
      limit: amount,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.user.id),
      message: { error: "Слишком много запросов. Попробуйте позже." },
    });
  const sendLimit = limit(180, 3600000);
  const directLimit = limit(30, 3600000);
  const readLimit = limit(1200, 60000);
  app.use("/api/groups", auth, readLimit);

  app.get(
    "/api/groups",
    wrap(async (req, res) => {
      const paging = pagination(req.query);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const data = await queryPage(tx, {
          paging,
          values: [actor.id],
          countSql: `SELECT count(*) AS count ${groupFrom} WHERE ${accessible}`,
          // Only page rows receive message summaries and per-group unread aggregates.
          itemsSql: ({ limit: take, offset }) => `WITH page AS MATERIALIZED (
          SELECT g.id ${groupFrom} WHERE ${accessible} ORDER BY g.updated_at DESC,g.id DESC LIMIT ${take} OFFSET ${offset})
          SELECT ${groupFields} ${groupFrom} JOIN page p ON p.id=g.id ORDER BY g.updated_at DESC,g.id DESC`,
        });
        data.unread = await unreadCount(tx, actor.id);
        return data;
      });
      res.json(result);
    }),
  );

  app.get(
    "/api/groups/unread-count",
    wrap(async (req, res) => {
      const unread = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        return unreadCount(tx, actor.id);
      });
      res.json({ unread });
    }),
  );

  app.get(
    "/api/groups/events/:eventId",
    wrap(async (req, res) => {
      const eventId = V.id.parse(req.params.eventId);
      const item = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const { rows } = await tx.query(
          "SELECT id FROM group_threads WHERE opportunity_id=$1 AND kind='event'",
          [eventId],
        );
        if (!rows[0]) fail(404, "Разговор недоступен");
        return lockGroup(tx, rows[0].id, actor);
      });
      res.json({ item });
    }),
  );

  app.get(
    "/api/groups/:id/messages",
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const before = req.query.before_id
        ? V.id.parse(req.query.before_id)
        : null;
      const after = req.query.after_id ? V.id.parse(req.query.after_id) : null;
      if (before && after) fail(400, "Выберите одно направление истории");
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const group = await lockGroup(tx, id, actor);
        const { rows } = await tx.query(
          `SELECT ${messageFields} FROM group_messages m
        LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.group_id=$1
        AND ($3::bigint IS NULL OR m.id<$3) AND ($4::bigint IS NULL OR m.id>$4)
        ORDER BY m.id ${after ? "ASC" : "DESC"} LIMIT 51`,
          [id, actor.id, before, after],
        );
        const items = rows.slice(0, 50);
        if (!after) items.reverse();
        return { group, items, has_more: rows.length > 50 };
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/groups/:id/messages",
    sendLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        data = messageSchema.parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        // Serialize a sender across groups so the durable hourly limit cannot race.
        await tx.query(
          "SELECT pg_advisory_xact_lock(91091,($1::bigint % 2147483647)::int)",
          [actor.id],
        );
        const group = await lockGroup(tx, id, actor, true);
        if (group.read_only)
          fail(409, "Мероприятие закрыто. Чат доступен только для чтения.");
        if (data.kind === "announcement" && !group.can_announce)
          fail(403, "Объявления публикует организатор мероприятия");
        const old = await tx.query(
          `SELECT ${messageFields} FROM group_messages m LEFT JOIN users u ON u.id=m.sender_user_id
        WHERE m.group_id=$1 AND m.client_id=$3`,
          [id, actor.id, data.client_id],
        );
        if (old.rows[0]) {
          const previous = old.rows[0];
          if (
            !same(previous.sender_user_id, actor.id) ||
            previous.body !== data.body ||
            previous.kind !== data.kind
          )
            fail(409, "Этот идентификатор уже использован другим сообщением");
          return { message: previous, duplicate: true };
        }
        const count = await tx.query(
          "SELECT count(*)::int AS count FROM group_messages WHERE sender_user_id=$1 AND created_at>NOW()-INTERVAL '1 hour'",
          [actor.id],
        );
        if (count.rows[0].count >= 120)
          fail(429, "Слишком много сообщений. Попробуйте позже.");
        const inserted = await tx.query(
          `INSERT INTO group_messages(group_id,sender_user_id,kind,body,client_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [id, actor.id, data.kind, data.body, data.client_id],
        );
        await tx.query(
          "UPDATE group_threads SET updated_at=NOW() WHERE id=$1",
          [id],
        );
        // Sending must not acknowledge messages that arrived since the last poll.
        if (audit)
          await audit(
            tx,
            actor.id,
            data.kind === "announcement"
              ? "group_announcement"
              : "group_message",
            "group",
            id,
          );
        const { rows } = await tx.query(
          `SELECT ${messageFields} FROM group_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.group_id=$1 AND m.id=$3`,
          [id, actor.id, inserted.rows[0].id],
        );
        return { message: rows[0], duplicate: false };
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );

  app.post(
    "/api/groups/:id/read",
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const { message_id } = z
        .object({ message_id: V.id })
        .strict()
        .parse(req.body);
      await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        await lockGroup(tx, id, actor);
        await markRead(tx, id, actor.id, message_id);
      });
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/groups/:id/members",
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        paging = pagination(req.query);
      const q = V.text(120).parse(req.query.q || "");
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const group = await lockGroup(tx, id, actor);
        const where = `FROM users u JOIN opportunities o ON o.id=$1 JOIN group_threads g ON g.id=$2
        WHERE ${memberSQL("u")} AND ($3::text='' OR u.full_name ILIKE '%'||$3||'%')
        AND (g.kind='event' OR u.id IN (g.user_low_id,g.user_high_id))`;
        return queryPage(tx, {
          paging,
          values: [group.opportunity_id, id, q],
          countSql: `SELECT count(*) AS count ${where}`,
          itemsSql: `SELECT u.id,u.full_name,u.role ${where} ORDER BY u.full_name,u.id`,
        });
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/groups/:id/direct",
    directLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const { user_id } = z.object({ user_id: V.id }).strict().parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const group = await lockGroup(tx, id, actor);
        if (group.kind !== "event")
          fail(400, "Выберите участника в чате мероприятия");
        if (same(actor.id, user_id)) fail(400, "Выберите другого участника");
        if (group.read_only)
          fail(409, "В закрытом мероприятии нельзя начать новый разговор");
        await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [user_id]);
        const member = await tx.query(
          `SELECT u.id FROM users u JOIN opportunities o ON o.id=$2 WHERE u.id=$1 AND ${memberSQL("u")}`,
          [user_id, group.opportunity_id],
        );
        if (!member.rows[0]) fail(404, "Участник недоступен");
        const low = Math.min(Number(actor.id), user_id),
          high = Math.max(Number(actor.id), user_id);
        const created = await tx.query(
          `INSERT INTO group_threads(opportunity_id,kind,user_low_id,user_high_id)
        VALUES($1,'direct',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
          [group.opportunity_id, low, high],
        );
        const directId =
          created.rows[0]?.id ||
          (
            await tx.query(
              "SELECT id FROM group_threads WHERE kind='direct' AND opportunity_id=$1 AND user_low_id=$2 AND user_high_id=$3",
              [group.opportunity_id, low, high],
            )
          ).rows[0].id;
        if (created.rows.length && audit)
          await audit(tx, actor.id, "group_direct_create", "group", directId);
        return {
          item: await groupItem(tx, directId, actor.id),
          created: Boolean(created.rows.length),
        };
      });
      res.status(result.created ? 201 : 200).json({ item: result.item });
    }),
  );
}

module.exports = { registerGroupMessagingRoutes };
