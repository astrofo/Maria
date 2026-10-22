const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const V = require("./validation");
const { pagination, queryPage } = require("./pagination");
const { z } = V;
const organizer = (user) => ["manager", "admin"].includes(user?.role);
const fail = (status, message, code) => {
  throw Object.assign(new Error(message), {
    status,
    ...(code ? { code } : {}),
  });
};
const same = (a, b) => String(a) === String(b);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const equalHash = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const messageSchema = z
  .object({
    body: V.text(4000).min(1),
    client_id: z.string().uuid(),
    guest_name: V.text(120).optional(),
    guest_email: V.email.optional(),
    opportunity_id: V.id.nullable().optional(),
  })
  .strict();
const campaignSchema = z.object({
  title: V.text(160).default(""),
  body: V.text(4000).default(""),
  kind: z.enum(["groups", "event"]).default("groups"),
  roles: z
    .array(z.enum(["volunteer", "coordinator", "manager", "admin"]))
    .max(4)
    .default(["volunteer"]),
  opportunity_id: V.id.nullable().default(null),
  action_label: V.text(60).default(""),
  target_type: z
    .enum(["opportunities", "training", "dashboard", "questionnaire", "event"])
    .nullable()
    .default(null),
});
const threadSelect = `SELECT t.*,COALESCE(u.full_name,NULLIF(t.guest_name,''),'Гость') AS display_name,
  u.role,u.status AS owner_status FROM chat_threads t LEFT JOIN users u ON u.id=t.owner_user_id`;
const campaignSelect = `SELECT c.*,o.title AS opportunity_title FROM message_campaigns c
  LEFT JOIN opportunities o ON o.id=c.opportunity_id`;

async function lockActor(tx, requestUser, requireOrganizer = false) {
  if (!requestUser) {
    if (requireOrganizer) fail(401, "Войдите в аккаунт");
    return null;
  }
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
    actor.status === "closed" ||
    actor.auth_version !== requestUser.auth_version
  )
    fail(401, "Сессия завершена. Войдите снова.");
  if (requireOrganizer && !organizer(actor))
    fail(403, "Этот раздел доступен организатору");
  return actor;
}

async function eventFor(tx, id, actor, lock = false) {
  if (!id) return null;
  const { rows } = await tx.query(
    `SELECT o.id,o.title,o.status,o.visibility,o.archived_at FROM opportunities o WHERE o.id=$1
      ${lock ? "AND o.archived_at IS NULL" : ""} AND (
      $2::boolean OR (o.archived_at IS NULL AND o.status='open' AND (o.visibility='public' OR EXISTS (
        SELECT 1 FROM opportunity_invitations i WHERE i.opportunity_id=o.id AND i.user_id=$3 AND i.status='active'))))
      ${lock ? "FOR SHARE OF o" : ""}`,
    [
      id,
      actor && ["coordinator", "manager", "admin"].includes(actor.role),
      actor?.id || null,
    ],
  );
  return rows[0] || null;
}

function publicThread(row, staffView = false) {
  if (!row) return null;
  const { guest_session_hash, guest_email, ...thread } = row;
  if (staffView) thread.guest_email = guest_email;
  return thread;
}

async function history(tx, thread, query, staffView) {
  const before = query.before_id ? V.id.parse(query.before_id) : null;
  const after = query.after_id ? V.id.parse(query.after_id) : null;
  if (before && after) fail(400, "Выберите одно направление истории");
  const { rows } = await tx.query(
    `SELECT m.id,m.thread_id,m.sender_user_id,m.sender_kind,m.body,m.created_at,
       COALESCE(u.full_name,CASE WHEN m.sender_kind='organizer' THEN 'Организатор' ELSE 'Гость' END) AS sender_name,
       CASE WHEN m.sender_kind='organizer' THEN m.id<=$4 ELSE m.id<=$5 END AS read
     FROM chat_messages m LEFT JOIN users u ON u.id=m.sender_user_id
     WHERE m.thread_id=$1 AND ($2::bigint IS NULL OR m.id<$2) AND ($3::bigint IS NULL OR m.id>$3)
     ORDER BY m.id ${after ? "ASC" : "DESC"} LIMIT 51`,
    [thread.id, before, after, thread.owner_read_id, thread.staff_read_id],
  );
  const has_more = rows.length > 50;
  const items = rows.slice(0, 50);
  if (!after) items.reverse();
  return {
    thread: publicThread(thread, staffView),
    items,
    has_more,
    email_available: false,
  };
}

async function readThrough(tx, thread, messageId, staffView) {
  const { rows } = await tx.query(
    "SELECT id FROM chat_messages WHERE thread_id=$1 AND id=$2",
    [thread.id, messageId],
  );
  if (!rows.length) fail(404, "Сообщение не найдено");
  const column = staffView ? "staff_read_id" : "owner_read_id";
  await tx.query(
    `UPDATE chat_threads SET ${column}=GREATEST(${column},$2) WHERE id=$1`,
    [thread.id, messageId],
  );
}

async function insertMessage(tx, thread, actor, data, staffView) {
  const kind = staffView ? "organizer" : actor ? "member" : "guest";
  const duplicate = await tx.query(
    "SELECT * FROM chat_messages WHERE thread_id=$1 AND client_id=$2",
    [thread.id, data.client_id],
  );
  if (duplicate.rows[0]) {
    const previous = duplicate.rows[0];
    if (
      previous.body !== data.body ||
      previous.sender_kind !== kind ||
      !same(previous.sender_user_id, actor?.id || null)
    )
      fail(409, "Этот идентификатор уже использован другим сообщением");
    return { message: previous, duplicate: true };
  }
  const rate = await tx.query(
    `SELECT count(*)::int AS count FROM chat_messages WHERE thread_id=$1 AND sender_kind=$2 AND created_at>NOW()-INTERVAL '1 hour'`,
    [thread.id, kind],
  );
  if (rate.rows[0].count >= (staffView ? 120 : 30))
    fail(429, "Слишком много сообщений. Попробуйте позже.");
  const { rows } = await tx.query(
    `INSERT INTO chat_messages(thread_id,sender_user_id,sender_kind,body,client_id)
     VALUES($1,$2,$3,$4,$5) RETURNING id,thread_id,sender_user_id,sender_kind,body,created_at`,
    [thread.id, actor?.id || null, kind, data.body, data.client_id],
  );
  await tx.query("UPDATE chat_threads SET updated_at=NOW() WHERE id=$1", [
    thread.id,
  ]);
  if (staffView && thread.owner_user_id) {
    await tx.query(
      `INSERT INTO notifications(user_id,title,body,kind,target_type,target_id,action_label)
       SELECT id,'Организатор ответил в чате','Откройте личный разговор с фондом.','chat_reply','chat',$2,'Открыть чат'
       FROM users WHERE id=$1 AND status<>'closed'`,
      [thread.owner_user_id, thread.id],
    );
  } else if (!staffView) {
    // Keep staff notifications free of guest names, contacts and message text.
    await tx.query(
      `INSERT INTO notifications(user_id,title,body,kind,target_type,target_id,action_label)
       SELECT id,'Новое сообщение фонду','В рабочем разделе появился новый вопрос.','chat_inbox','inbox',$1,'Открыть диалоги'
       FROM users WHERE role IN ('manager','admin') AND status<>'closed'`,
      [thread.id],
    );
  }
  return { message: rows[0], duplicate: false };
}

function campaignValues(data) {
  if (data.kind === "groups" && data.target_type === "event")
    fail(400, "Карточка события доступна для рассылки по мероприятию");
  return [
    data.title,
    data.body,
    data.kind,
    [...new Set(data.roles)].sort(),
    data.kind === "event" ? data.opportunity_id : null,
    data.action_label,
    data.kind === "event" && data.action_label ? "event" : data.target_type,
  ];
}

// Only IDs stay in SQL. Neither preview nor delivery loads the entire audience
// into application memory. The same predicate is used at review/send/delivery.
const audienceSQL = `SELECT u.id FROM users u WHERE u.status<>'closed' AND (
  ($1::text='groups' AND u.role=ANY($2::text[])) OR
  ($1::text='event' AND EXISTS (
    SELECT 1 FROM opportunities o JOIN applications a ON a.opportunity_id=o.id
    WHERE o.id=$3 AND o.archived_at IS NULL AND o.status='open' AND a.user_id=u.id AND a.status='accepted'
      AND (o.visibility='public' OR u.role IN ('coordinator','manager','admin') OR EXISTS (
        SELECT 1 FROM opportunity_invitations i WHERE i.opportunity_id=o.id AND i.user_id=u.id AND i.status='active')))))`;
const audienceArgs = (campaign) => [
  campaign.kind,
  campaign.roles,
  campaign.opportunity_id,
];
function campaignPublic(row) {
  const { review_hash, client_id, ...result } = row;
  return result;
}
async function getCampaign(tx, id, lock = false) {
  const { rows } = await tx.query(
    `${campaignSelect} WHERE c.id=$1 ${lock ? "FOR UPDATE OF c" : ""}`,
    [id],
  );
  if (!rows[0]) fail(404, "Рассылка не найдена");
  return rows[0];
}

function registerMessagingRoutes(app, { db, auth, requireRole, wrap, audit }) {
  const guestHash = (req) =>
    crypto
      .createHmac("sha256", process.env.SESSION_SECRET)
      .update(JSON.stringify(["guest-chat-v1", req.sessionID]))
      .digest("hex");
  const reviewHash = (req, token) =>
    hash(JSON.stringify([token, req.sessionID, req.user.id]));
  const ownThread = async (tx, req, lock = false) => {
    const values = req.user ? [req.user.id, null] : [null, guestHash(req)];
    const { rows } = await tx.query(
      `${threadSelect} WHERE ($1::bigint IS NOT NULL AND t.owner_user_id=$1)
      OR ($1::bigint IS NULL AND t.guest_session_hash=$2) ${lock ? "FOR UPDATE OF t" : ""}`,
      values,
    );
    return rows[0] || null;
  };
  const inboxGuard = [auth, requireRole("manager")];
  const limit = (amount, windowMs = 3600000) =>
    rateLimit({
      windowMs,
      limit: amount,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Слишком много запросов. Попробуйте позже." },
    });
  const chatLimit = limit(60);
  const campaignLimit = limit(30);

  app.get(
    "/api/chat",
    limit(1200),
    wrap(async (req, res) => {
      const data = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const thread = await ownThread(tx, req);
        if (!thread)
          return {
            thread: null,
            items: [],
            has_more: false,
            email_available: false,
          };
        const data = await history(tx, thread, req.query, false);
        data.event = await eventFor(tx, thread.opportunity_id, actor);
        return data;
      });
      res.json(data);
    }),
  );
  app.post(
    "/api/chat/messages",
    chatLimit,
    wrap(async (req, res) => {
      const data = messageSchema.parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        if (
          data.opportunity_id &&
          !(await eventFor(tx, data.opportunity_id, actor, true))
        )
          fail(404, "Мероприятие недоступно");
        let thread = await ownThread(tx, req, true);
        if (!thread) {
          if (!actor && !data.guest_email)
            fail(400, "Укажите электронную почту");
          // The unique owner/session key serializes simultaneous first messages.
          await tx.query(
            `INSERT INTO chat_threads(owner_user_id,guest_session_hash,guest_name,guest_email,opportunity_id)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [
              actor?.id || null,
              actor ? null : guestHash(req),
              actor ? null : data.guest_name || "Гость",
              actor ? null : data.guest_email,
              data.opportunity_id || null,
            ],
          );
          thread = await ownThread(tx, req, true);
        }
        const result = await insertMessage(tx, thread, actor, data, false);
        if (data.opportunity_id && !result.duplicate)
          await tx.query(
            "UPDATE chat_threads SET opportunity_id=$2 WHERE id=$1",
            [thread.id, data.opportunity_id],
          );
        if (!result.duplicate)
          await audit(
            tx,
            actor?.id || null,
            "chat_message",
            "chat_thread",
            thread.id,
          );
        return { ...result, thread_id: thread.id, email_available: false };
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );
  app.post(
    "/api/chat/read",
    wrap(async (req, res) => {
      const messageId = V.id.parse(req.body.message_id);
      await db.transaction(async (tx) => {
        await lockActor(tx, req.user);
        const thread = await ownThread(tx, req, true);
        if (!thread) fail(404, "Разговор не найден");
        await readThrough(tx, thread, messageId, false);
      });
      res.status(204).end();
    }),
  );

  app.get(
    "/api/messages/threads",
    ...inboxGuard,
    wrap(async (req, res) => {
      const paging = pagination(req.query);
      const query = V.text(120).parse(req.query.q || "");
      const filter = z
        .enum([
          "all",
          "unread",
          "guest",
          "volunteer",
          "coordinator",
          "manager",
          "admin",
        ])
        .parse(req.query.filter || "all");
      const data = await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const where = `WHERE ($1::text='' OR COALESCE(u.full_name,t.guest_name,'') ILIKE '%'||$1||'%' OR EXISTS(
        SELECT 1 FROM chat_messages s WHERE s.thread_id=t.id AND s.body ILIKE '%'||$1||'%'))
        AND ($2::text='all' OR ($2='guest' AND t.owner_user_id IS NULL) OR u.role=$2 OR
          ($2='unread' AND EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.sender_kind<>'organizer' AND m.id>t.staff_read_id)))`;
        return queryPage(tx, {
          paging,
          values: [query, filter],
          countSql: `SELECT count(*) AS count FROM chat_threads t LEFT JOIN users u ON u.id=t.owner_user_id ${where}`,
          itemsSql: `SELECT t.id,t.owner_user_id,COALESCE(u.full_name,NULLIF(t.guest_name,''),'Гость') AS display_name,u.role,t.updated_at,
          (SELECT body FROM chat_messages m WHERE m.thread_id=t.id ORDER BY id DESC LIMIT 1) AS last_message,
          EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id=t.id AND m.sender_kind<>'organizer' AND m.id>t.staff_read_id) AS unread
          FROM chat_threads t LEFT JOIN users u ON u.id=t.owner_user_id ${where} ORDER BY t.updated_at DESC,t.id DESC`,
        });
      });
      res.json(data);
    }),
  );
  app.get(
    "/api/messages/threads/:id",
    ...inboxGuard,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const data = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        const { rows } = await tx.query(`${threadSelect} WHERE t.id=$1`, [id]);
        if (!rows[0]) fail(404, "Разговор не найден");
        const result = await history(tx, rows[0], req.query, true);
        result.event = await eventFor(tx, rows[0].opportunity_id, actor);
        return result;
      });
      res.json(data);
    }),
  );
  app.post(
    "/api/messages/threads/:id/messages",
    ...inboxGuard,
    chatLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        data = messageSchema
          .pick({ body: true, client_id: true })
          .parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        const { rows } = await tx.query(
          `${threadSelect} WHERE t.id=$1 FOR UPDATE OF t`,
          [id],
        );
        const thread = rows[0];
        if (!thread) fail(404, "Разговор не найден");
        if (thread.owner_status === "closed")
          fail(409, "Аккаунт собеседника закрыт");
        const result = await insertMessage(tx, thread, actor, data, true);
        if (!result.duplicate)
          await audit(tx, actor.id, "chat_reply", "chat_thread", id);
        return { ...result, email_available: false };
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );
  app.post(
    "/api/messages/threads/:id/read",
    ...inboxGuard,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        messageId = V.id.parse(req.body.message_id);
      await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const { rows } = await tx.query(
          "SELECT * FROM chat_threads WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (!rows[0]) fail(404, "Разговор не найден");
        await readThrough(tx, rows[0], messageId, true);
      });
      res.status(204).end();
    }),
  );

  app.get(
    "/api/campaigns",
    ...inboxGuard,
    wrap(async (req, res) => {
      const paging = pagination(req.query),
        q = V.text(120).parse(req.query.q || "");
      const status = z
        .enum(["all", "draft", "queued", "sending", "sent", "cancelled"])
        .parse(req.query.status || "all");
      res.json(
        await db.transaction(async (tx) => {
          await lockActor(tx, req.user, true);
          const where =
            "WHERE ($1::text='' OR c.title ILIKE '%'||$1||'%') AND ($2::text='all' OR c.status=$2)";
          const data = await queryPage(tx, {
            paging,
            values: [q, status],
            countSql: `SELECT count(*) AS count FROM message_campaigns c ${where}`,
            itemsSql: `${campaignSelect} ${where} ORDER BY c.updated_at DESC,c.id DESC`,
          });
          data.items = data.items.map(campaignPublic);
          return data;
        }),
      );
    }),
  );
  app.post(
    "/api/campaigns/audience-preview",
    ...inboxGuard,
    limit(180),
    wrap(async (req, res) => {
      const data = campaignSchema.strict().parse(req.body);
      campaignValues(data);
      res.json(
        await db.transaction(async (tx) => {
          await lockActor(tx, req.user, true);
          const count = await tx.query(
            `SELECT count(*)::int AS count FROM (${audienceSQL}) audience`,
            audienceArgs(data),
          );
          return {
            recipient_count: count.rows[0].count,
            email_available: false,
          };
        }),
      );
    }),
  );
  app.get(
    "/api/campaigns/:id",
    ...inboxGuard,
    wrap(async (req, res) => {
      res.json(
        await db.transaction(async (tx) => {
          await lockActor(tx, req.user, true);
          const campaign = await getCampaign(tx, V.id.parse(req.params.id));
          const count = await tx.query(
            `SELECT count(*)::int AS count FROM (${audienceSQL}) audience`,
            audienceArgs(campaign),
          );
          return {
            campaign: campaignPublic(campaign),
            current_recipient_count: count.rows[0].count,
            email_available: false,
          };
        }),
      );
    }),
  );
  app.post(
    "/api/campaigns",
    ...inboxGuard,
    campaignLimit,
    wrap(async (req, res) => {
      const data = campaignSchema
        .extend({ client_id: z.string().uuid() })
        .strict()
        .parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        if (
          data.opportunity_id &&
          !(await eventFor(tx, data.opportunity_id, actor, true))
        )
          fail(404, "Мероприятие не найдено");
        const values = campaignValues(data);
        const matchExisting = (row) => {
          if (
            row.title !== values[0] ||
            row.body !== values[1] ||
            row.kind !== values[2] ||
            JSON.stringify([...row.roles].sort()) !==
              JSON.stringify(values[3]) ||
            !same(row.opportunity_id, values[4]) ||
            row.action_label !== values[5] ||
            row.target_type !== values[6]
          )
            fail(
              409,
              "Черновик с этим идентификатором уже создан. Откройте его из истории рассылок.",
              "idempotency_conflict",
            );
          return campaignPublic(row);
        };
        const old = await tx.query(
          "SELECT * FROM message_campaigns WHERE created_by=$1 AND client_id=$2",
          [actor.id, data.client_id],
        );
        if (old.rows[0]) return matchExisting(old.rows[0]);
        const { rows } = await tx.query(
          `INSERT INTO message_campaigns(title,body,kind,roles,opportunity_id,action_label,target_type,created_by,client_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(created_by,client_id) DO NOTHING RETURNING *`,
          [...values, actor.id, data.client_id],
        );
        const campaign =
          rows[0] ||
          (
            await tx.query(
              "SELECT * FROM message_campaigns WHERE created_by=$1 AND client_id=$2",
              [actor.id, data.client_id],
            )
          ).rows[0];
        if (rows.length)
          await audit(tx, actor.id, "campaign_draft", "campaign", campaign.id);
        return matchExisting(campaign);
      });
      res.status(201).json({ campaign: result });
    }),
  );
  app.patch(
    "/api/campaigns/:id",
    ...inboxGuard,
    campaignLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const data = campaignSchema
        .extend({ expected_version: V.id })
        .strict()
        .parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        if (
          data.opportunity_id &&
          !(await eventFor(tx, data.opportunity_id, actor, true))
        )
          fail(404, "Мероприятие не найдено");
        const campaign = await getCampaign(tx, id, true);
        if (campaign.status !== "draft")
          fail(409, "Отправленную рассылку нельзя изменить");
        if (campaign.version !== data.expected_version)
          fail(409, "Черновик уже изменён. Откройте актуальную версию.");
        const { rows } = await tx.query(
          `UPDATE message_campaigns SET title=$1,body=$2,kind=$3,roles=$4,opportunity_id=$5,
        action_label=$6,target_type=$7,version=version+1,review_hash=NULL,review_expires_at=NULL,recipient_count=0,updated_at=NOW() WHERE id=$8 RETURNING *`,
          [...campaignValues(data), id],
        );
        await tx.query("DELETE FROM campaign_recipients WHERE campaign_id=$1", [
          id,
        ]);
        await audit(tx, actor.id, "campaign_edit", "campaign", id);
        return campaignPublic(rows[0]);
      });
      res.json({ campaign: result });
    }),
  );
  app.post(
    "/api/campaigns/:id/review",
    ...inboxGuard,
    campaignLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        expected = V.id.parse(req.body.expected_version);
      const result = await db.transaction(async (tx) => {
        await lockActor(tx, req.user, true);
        const campaign = await getCampaign(tx, id, true);
        if (campaign.status !== "draft" || campaign.version !== expected)
          fail(409, "Откройте актуальный черновик");
        if (!campaign.title.trim() || !campaign.body.trim())
          fail(400, "Заполните заголовок и текст уведомления");
        if (Boolean(campaign.action_label) !== Boolean(campaign.target_type))
          fail(
            400,
            "Укажите подпись и назначение кнопки либо оставьте оба поля пустыми",
          );
        await tx.query("DELETE FROM campaign_recipients WHERE campaign_id=$1", [
          id,
        ]);
        await tx.query(
          `INSERT INTO campaign_recipients(campaign_id,user_id) SELECT $4,id FROM (${audienceSQL}) audience`,
          [...audienceArgs(campaign), id],
        );
        const count = (
          await tx.query(
            "SELECT count(*)::int AS count FROM campaign_recipients WHERE campaign_id=$1",
            [id],
          )
        ).rows[0].count;
        if (!count)
          fail(
            409,
            "Нет доступных получателей. Для события нужны подтверждённые участники опубликованной встречи.",
          );
        const token = crypto.randomBytes(32).toString("hex");
        const { rows } = await tx.query(
          "UPDATE message_campaigns SET review_hash=$2,review_expires_at=NOW()+INTERVAL '5 minutes',recipient_count=$3 WHERE id=$1 RETURNING *",
          [id, reviewHash(req, token), count],
        );
        return {
          campaign: campaignPublic({
            ...rows[0],
            opportunity_title: campaign.opportunity_title,
          }),
          review_token: token,
          expires_in: 300,
          recipient_count: count,
        };
      });
      res.json(result);
    }),
  );
  app.post(
    "/api/campaigns/:id/send",
    ...inboxGuard,
    campaignLimit,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id),
        token = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(req.body.review_token);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        const campaign = await getCampaign(tx, id, true);
        if (campaign.status !== "draft") {
          if (equalHash(campaign.review_hash, reviewHash(req, token)))
            return campaignPublic(campaign);
          fail(409, "Рассылка уже отправлена или отменена");
        }
        if (
          !equalHash(campaign.review_hash, reviewHash(req, token)) ||
          new Date(campaign.review_expires_at) <= new Date()
        )
          fail(
            409,
            "Повторите проверку рассылки перед отправкой",
            "review_required",
          );
        const changes = await tx.query(
          `WITH current_audience AS (${audienceSQL}), previous AS (
        SELECT user_id AS id FROM campaign_recipients WHERE campaign_id=$4)
        SELECT EXISTS((SELECT id FROM current_audience EXCEPT SELECT id FROM previous)
          UNION ALL (SELECT id FROM previous EXCEPT SELECT id FROM current_audience)) AS changed`,
          [...audienceArgs(campaign), id],
        );
        if (changes.rows[0].changed)
          fail(
            409,
            "Состав получателей изменился. Повторите проверку рассылки.",
            "audience_changed",
          );
        const { rows } = await tx.query(
          "UPDATE message_campaigns SET status='queued',sent_by=$2,updated_at=NOW() WHERE id=$1 RETURNING *",
          [id, actor.id],
        );
        await audit(tx, actor.id, "campaign_send", "campaign", id);
        return campaignPublic(rows[0]);
      });
      res.status(202).json({ campaign: result });
    }),
  );
}

async function deliverCampaignBatch(db) {
  return db.transaction(async (tx) => {
    await tx.exec(
      "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'",
    );
    const lock = await tx.query(
      "SELECT pg_try_advisory_xact_lock(1145918281,23) AS acquired",
    );
    if (!lock.rows[0]?.acquired) return;
    await tx.query(
      "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
    );
    const candidate = (
      await tx.query(
        "SELECT id,sent_by,opportunity_id FROM message_campaigns WHERE status IN ('queued','sending') ORDER BY id LIMIT 1",
      )
    ).rows[0];
    if (!candidate) return;
    const sender = (
      await tx.query("SELECT id,role,status FROM users WHERE id=$1 FOR SHARE", [
        candidate.sent_by,
      ])
    ).rows[0];
    // Event writers also lock the event before participants/invitations. Keep
    // eligibility stable while this batch produces its notifications.
    let eventArchived = false;
    if (candidate.opportunity_id) {
      const event = await tx.query(
        "SELECT id,archived_at FROM opportunities WHERE id=$1 FOR SHARE",
        [candidate.opportunity_id],
      );
      eventArchived = Boolean(event.rows[0]?.archived_at);
    }
    const campaign = await getCampaign(tx, candidate.id, true);
    if (!["queued", "sending"].includes(campaign.status)) return;
    if (!organizer(sender) || sender.status === "closed" || eventArchived) {
      await tx.query(
        "UPDATE message_campaigns SET status='cancelled',updated_at=NOW() WHERE id=$1",
        [campaign.id],
      );
      return;
    }
    const recipients = await tx.query(
      "SELECT user_id FROM campaign_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY user_id LIMIT 100 FOR UPDATE",
      [campaign.id],
    );
    const ids = recipients.rows.map((row) => row.user_id);
    if (!ids.length) {
      await tx.query(
        "UPDATE message_campaigns SET status='sent',sent_at=NOW(),updated_at=NOW() WHERE id=$1",
        [campaign.id],
      );
      return;
    }
    await tx.query(
      "SELECT id FROM users WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE",
      [ids],
    );
    const eligible = await tx.query(
      `SELECT id FROM (${audienceSQL}) audience WHERE id=ANY($4::bigint[])`,
      [...audienceArgs(campaign), ids],
    );
    const allowed = eligible.rows.map((row) => row.id);
    if (allowed.length) {
      await tx.query(
        `INSERT INTO notifications(user_id,title,body,kind,target_type,target_id,action_label)
        SELECT user_id,$2,$3,$4,$5,$6,$7 FROM unnest($1::bigint[]) recipients(user_id)`,
        [
          allowed,
          campaign.title,
          campaign.body,
          campaign.kind === "event" ? "event_campaign" : "campaign",
          campaign.target_type,
          campaign.kind === "event" ? campaign.opportunity_id : null,
          campaign.action_label || null,
        ],
      );
    }
    await tx.query(
      "UPDATE campaign_recipients SET status=CASE WHEN user_id=ANY($3::bigint[]) THEN 'delivered' ELSE 'skipped' END WHERE campaign_id=$1 AND user_id=ANY($2::bigint[])",
      [campaign.id, ids, allowed],
    );
    await tx.query(
      "UPDATE message_campaigns SET status='sending',delivered_count=delivered_count+$2,skipped_count=skipped_count+$3,updated_at=NOW() WHERE id=$1",
      [campaign.id, allowed.length, ids.length - allowed.length],
    );
  });
}

function startCampaignDelivery({ db, intervalMs = 1000 }) {
  let stopped = false,
    active = null;
  const tick = () => {
    if (stopped || active) return;
    active = deliverCampaignBatch(db)
      .catch(() => console.error("Campaign delivery pass failed"))
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (active) await active;
  };
}

module.exports = { registerMessagingRoutes, startCampaignDelivery };
