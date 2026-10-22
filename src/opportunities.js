const V = require("./validation");
const { enqueueEventNotification } = require("./notification-queue");
const {
  readTrainingRequirements,
  requireEventTraining,
} = require("./training-progress");
const {
  pagination,
  period,
  readPage,
  readSnapshot,
  queryPage,
} = require("./pagination");
const { z } = V;

function registerOpportunityRoutes(
  app,
  {
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
  },
) {
  const manages = (user) => user.role === "manager" || user.role === "admin";
  const lockActor = async (tx, requestUser, staffRequired = false) => {
    // Role/status changes use this order before locking a target user.
    await tx.query(
      "SELECT id FROM users WHERE role='admin' ORDER BY id FOR SHARE",
    );
    const actor = await getOne(
      tx,
      "SELECT id,full_name,role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
      [requestUser.id],
    );
    if (
      (staffRequired && !staff(actor)) ||
      actor.status === "closed" ||
      actor.auth_version !== requestUser.auth_version
    )
      fail(403, "Права доступа изменились. Войдите в аккаунт снова.");
    return actor;
  };

  const eventValues = (d) => [
    d.title,
    d.description,
    d.city || null,
    d.format || null,
    d.starts_at || null,
    d.ends_at || null,
    d.status,
    d.skills,
    d.interests,
    d.location || null,
    d.capacity || null,
    d.visibility,
    d.cover_url || null,
    d.cover_alt || null,
    d.coordinator_id || null,
    d.required_course_id || null,
    d.application_deadline || null,
    d.preparation || null,
  ];

  const validatePreparation = async (tx, data, previous) => {
    // Preserve historical assignments on closed events. New assignments and
    // reopening an event must use available records locked through save.
    if (
      data.coordinator_id &&
      String(data.coordinator_id) !== String(previous?.coordinator_id)
    ) {
      const { rows } = await tx.query(
        "SELECT id,role,status FROM users WHERE id=$1 FOR SHARE",
        [data.coordinator_id],
      );
      if (!rows[0] || !staff(rows[0]) || rows[0].status !== "active")
        fail(
          400,
          "Выберите активного координатора или другого сотрудника фонда",
        );
    }
    if (
      data.required_course_id &&
      (String(data.required_course_id) !==
        String(previous?.required_course_id) ||
        data.status === "open" ||
        data.status === "draft")
    ) {
      const { rows } = await tx.query(
        "SELECT id,status,archived_at FROM courses WHERE id=$1 FOR SHARE",
        [data.required_course_id],
      );
      if (!rows[0] || rows[0].status !== "published" || rows[0].archived_at)
        fail(400, "Выберите опубликованный курс подготовки");
    }
  };

  // After checking the actor under user locks, mutations lock the event before
  // its invitations/applications. This also protects capacity and recorded hours.
  const lockEvent = (tx, id) =>
    getOne(tx, "SELECT * FROM opportunities WHERE id=$1 FOR UPDATE", [id]);

  const assertNotArchived = (event) => {
    if (event.archived_at)
      fail(409, "Мероприятие удалено. Сначала восстановите его из корзины.");
  };

  const archiveFilter = (query, user) => {
    const archived =
      z.enum(["true", "false"]).optional().parse(query.archived) === "true";
    if (archived && !staff(user))
      fail(403, "Корзина доступна сотрудникам фонда");
    return archived;
  };

  const hasInvitation = async (tx, opportunityId, userId) => {
    const { rows } = await tx.query(
      "SELECT id FROM opportunity_invitations WHERE opportunity_id=$1 AND user_id=$2 AND status='active'",
      [opportunityId, userId],
    );
    return rows.length > 0;
  };

  const preparationJoins = `LEFT JOIN users coordinator ON coordinator.id=o.coordinator_id
    LEFT JOIN courses preparation_course ON preparation_course.id=o.required_course_id`;
  const availableCoordinator =
    "coordinator.role IN ('coordinator','manager','admin') AND coordinator.status='active'";
  const opportunityFrom = `FROM opportunities o
    ${preparationJoins}
    LEFT JOIN applications a ON a.opportunity_id=o.id AND a.user_id=$1
    LEFT JOIN opportunity_invitations i
      ON i.opportunity_id=o.id AND i.user_id=$1 AND i.status='active'`;
  const opportunityAccess = `($2::boolean OR (
      (o.archived_at IS NULL AND (o.visibility='public' OR i.id IS NOT NULL)
        AND (o.status='open' OR (a.id IS NOT NULL AND o.status<>'draft')))
      OR (o.archived_at IS NOT NULL AND o.status<>'draft' AND a.id IS NOT NULL
        AND (o.visibility='public' OR i.id IS NOT NULL))
    ))`;
  const opportunityFields = `o.*,a.status AS my_application,a.id AS my_application_id,i.status AS my_invitation,
    CASE WHEN $2::boolean OR (${availableCoordinator}) THEN coordinator.full_name END AS coordinator_name,
    CASE WHEN $2::boolean OR (preparation_course.status='published' AND preparation_course.archived_at IS NULL) THEN preparation_course.document->>'title' END AS required_course_title`;
  const opportunitySelect = `SELECT ${opportunityFields},
    (SELECT COUNT(*)::int FROM applications x
      WHERE x.opportunity_id=o.id AND x.status='accepted') AS accepted_count
    ${opportunityFrom} WHERE ${opportunityAccess}`;

  const withMatchScore = (event, user) => {
    const tags = new Set(
      [...user.skills, ...user.interests].map((t) => t.toLowerCase()),
    );
    return {
      ...event,
      match_score: [...event.skills, ...event.interests].filter((t) =>
        tags.has(t.toLowerCase()),
      ).length,
    };
  };

  const invitationSelect = `
    SELECT i.*,u.full_name,u.email,u.status AS user_status,
      a.status AS application_status
    FROM opportunity_invitations i JOIN users u ON u.id=i.user_id
    LEFT JOIN applications a ON a.opportunity_id=i.opportunity_id AND a.user_id=i.user_id
    WHERE i.opportunity_id=$1 AND ($2::boolean OR u.role='volunteer')`;

  // Keep this allowlist separate from authenticated opportunity projections:
  // guest responses contain no staff IDs, applications or invitation metadata.
  const publicFields = `o.id,o.title,o.description,o.city,o.format,o.starts_at,o.ends_at,
    o.status,o.skills,o.interests,o.location,o.capacity,o.visibility,o.cover_url,o.cover_alt,o.created_at,
    o.required_course_id,o.application_deadline,o.preparation,
    CASE WHEN ${availableCoordinator} THEN coordinator.full_name END AS coordinator_name,
    CASE WHEN preparation_course.status='published' AND preparation_course.archived_at IS NULL THEN preparation_course.document->>'title' END AS required_course_title`;
  const publicAccess =
    "o.archived_at IS NULL AND o.visibility='public' AND o.status IN ('open','closed')";

  const opportunityFilters = (query, publicOnly, offset = 0) => {
    const dates = period(query);
    const q = V.text(120).parse(query.q || "");
    const status = query.status
      ? z
          .enum(publicOnly ? ["open", "closed"] : ["draft", "open", "closed"])
          .parse(query.status)
      : null;
    const values = [
      q ? `%${q}%` : "",
      status,
      dates.date_from,
      dates.date_to,
      V.text(120).parse(query.city || ""),
      V.text(100).parse(query.format || ""),
      V.text(80).parse(query.skill || ""),
      V.text(80).parse(query.interest || ""),
      z.enum(["true", "false"]).optional().parse(query.available) === "true",
    ];
    const sort = z
      .enum(["soonest", "latest", "newest"])
      .parse(query.sort ?? "soonest");
    const p = values.map((_, index) => `$${offset + index + 1}`);
    return {
      values,
      sort,
      where: `AND (${p[0]}::text='' OR o.title ILIKE ${p[0]} OR o.description ILIKE ${p[0]} OR o.city ILIKE ${p[0]}
          OR EXISTS (SELECT 1 FROM unnest(o.skills || o.interests) tag WHERE tag ILIKE ${p[0]}))
        AND (${p[1]}::text IS NULL OR o.status=${p[1]})
        AND (${p[2]}::date IS NULL OR o.starts_at >= (${p[2]}::date::timestamp AT TIME ZONE 'UTC'))
        AND (${p[3]}::date IS NULL OR o.starts_at < ((${p[3]}::date + 1)::timestamp AT TIME ZONE 'UTC'))
        AND (${p[4]}::text='' OR lower(btrim(COALESCE(o.city,'')))=lower(${p[4]}))
        AND (${p[5]}::text='' OR lower(btrim(COALESCE(o.format,'')))=lower(${p[5]}))
        AND (${p[6]}::text='' OR EXISTS (
          SELECT 1 FROM unnest(o.skills) tag WHERE lower(btrim(tag))=lower(${p[6]})))
        AND (${p[7]}::text='' OR EXISTS (
          SELECT 1 FROM unnest(o.interests) tag WHERE lower(btrim(tag))=lower(${p[7]})))
        AND (NOT ${p[8]}::boolean OR (
          o.status='open'
          AND (COALESCE(o.ends_at,o.starts_at) IS NULL OR COALESCE(o.ends_at,o.starts_at)>=CURRENT_TIMESTAMP)
          AND (o.application_deadline IS NULL OR o.application_deadline>CURRENT_TIMESTAMP)
          AND (o.capacity IS NULL OR (
            SELECT COUNT(*) FROM applications capacity_application
            WHERE capacity_application.opportunity_id=o.id AND capacity_application.status='accepted'
          )<o.capacity)
        ))`,
    };
  };

  // Both aliases and ordering expressions are fixed application strings, never
  // request SQL. Keep the final order identical to the order inside the page.
  const opportunityOrder = (sort, alias = "o") =>
    ({
      soonest: `${alias}.starts_at ASC NULLS LAST,${alias}.id DESC`,
      latest: `${alias}.starts_at DESC NULLS LAST,${alias}.id DESC`,
      newest: `${alias}.created_at DESC,${alias}.id DESC`,
    })[sort];

  const filterOptions = async (from, access, values = []) => {
    const { rows } = await db.query(
      `WITH accessible AS MATERIALIZED (
        SELECT o.city,o.format,o.skills,o.interests ${from} WHERE ${access}
      ), raw_options AS (
        SELECT 'cities' AS kind,city AS value FROM accessible
        UNION ALL SELECT 'formats',format FROM accessible
        UNION ALL SELECT 'skills',unnest(skills) FROM accessible
        UNION ALL SELECT 'interests',unnest(interests) FROM accessible
      ), unique_options AS (
        SELECT kind,lower(btrim(value)) AS normalized,MIN(btrim(value)) AS value
        FROM raw_options WHERE NULLIF(btrim(value),'') IS NOT NULL
        GROUP BY kind,lower(btrim(value))
      ), ranked_options AS (
        SELECT kind,value,ROW_NUMBER() OVER (
          PARTITION BY kind ORDER BY normalized,value
        ) AS position FROM unique_options
      ) SELECT kind,ARRAY_AGG(value ORDER BY position) AS values
        FROM ranked_options WHERE position<=100 GROUP BY kind`,
      values,
    );
    const result = { cities: [], formats: [], skills: [], interests: [] };
    for (const row of rows) result[row.kind] = row.values;
    return result;
  };

  app.get(
    "/api/public/opportunities/options/filters",
    wrap(async (_req, res) => {
      res.json(await filterOptions("FROM opportunities o", publicAccess));
    }),
  );

  app.get(
    "/api/public/opportunities",
    wrap(async (req, res) => {
      const paging = pagination(req.query);
      const filters = opportunityFilters(req.query, true);
      const where = `WHERE ${publicAccess} ${filters.where}`;
      res.json(
        await readPage(db, {
          paging,
          values: filters.values,
          countSql: `SELECT count(*) AS count FROM opportunities o ${where}`,
          itemsSql: `SELECT ${publicFields} FROM opportunities o ${preparationJoins} ${where} ORDER BY ${opportunityOrder(filters.sort)}`,
        }),
      );
    }),
  );

  app.get(
    "/api/public/opportunities/:id",
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const item = await getOne(
        db,
        `SELECT ${publicFields} FROM opportunities o ${preparationJoins} WHERE ${publicAccess} AND o.id=$1`,
        [id],
        "Мероприятие не найдено",
      );
      res.json({ item });
    }),
  );

  app.get(
    "/api/opportunities/options/filters",
    auth,
    wrap(async (req, res) => {
      const archived = archiveFilter(req.query, req.user);
      res.json(
        await filterOptions(
          opportunityFrom,
          `${opportunityAccess} AND (o.archived_at IS NOT NULL)=$3::boolean`,
          [req.user.id, staff(req.user), archived],
        ),
      );
    }),
  );

  app.get(
    "/api/opportunities/options/coordinators",
    requireRole("manager"),
    wrap(async (req, res) => {
      const q = V.text(120).parse(req.query.q || "");
      const where =
        "WHERE role IN ('coordinator','manager','admin') AND status='active' AND ($1='' OR full_name ILIKE $1)";
      res.json(
        await readPage(db, {
          paging: pagination(req.query),
          values: [q ? `%${q}%` : ""],
          countSql: `SELECT COUNT(*) AS count FROM users ${where}`,
          itemsSql: `SELECT id,full_name,role FROM users ${where} ORDER BY full_name,id`,
        }),
      );
    }),
  );

  app.get(
    "/api/opportunities",
    auth,
    wrap(async (req, res) => {
      const paging = pagination(req.query);
      const archived = archiveFilter(req.query, req.user);
      const filters = opportunityFilters(req.query, false, 3);
      const where = `WHERE ${opportunityAccess} AND (o.archived_at IS NOT NULL)=$3::boolean ${filters.where}`;
      const result = await readPage(db, {
        paging,
        values: [req.user.id, staff(req.user), archived, ...filters.values],
        countSql: `SELECT COUNT(*) AS count ${opportunityFrom} ${where}`,
        itemsSql: ({ limit, offset }) => `WITH page AS MATERIALIZED (
          SELECT ${opportunityFields} ${opportunityFrom} ${where}
          ORDER BY ${opportunityOrder(filters.sort)} LIMIT ${limit} OFFSET ${offset}
        ) SELECT page.*,(SELECT COUNT(*)::int FROM applications x
          WHERE x.opportunity_id=page.id AND x.status='accepted') AS accepted_count
          FROM page ORDER BY ${opportunityOrder(filters.sort, "page")}`,
      });
      result.items = result.items.map((event) =>
        withMatchScore(event, req.user),
      );
      if (req.user.role === "volunteer") {
        const requirements = await readTrainingRequirements(
          db,
          result.items.map((item) => item.required_course_id),
          req.user,
        );
        for (const item of result.items)
          item.training_requirement =
            requirements.get(String(item.required_course_id)) || null;
      }
      res.json(result);
    }),
  );

  app.get(
    "/api/opportunities/:id",
    auth,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const item = await getOne(db, `${opportunitySelect} AND o.id=$3`, [
        req.user.id,
        staff(req.user),
        id,
      ]);
      const result = withMatchScore(item, req.user);
      if (req.user.role === "volunteer") {
        const requirements = await readTrainingRequirements(
          db,
          [item.required_course_id],
          req.user,
        );
        result.training_requirement =
          requirements.get(String(item.required_course_id)) || null;
      }
      res.json({ item: result });
    }),
  );

  app.post(
    "/api/opportunities",
    requireRole("manager"),
    wrap(async (req, res) => {
      const d = V.opportunity.parse(req.body);
      const item = await db.transaction(async (tx) => {
        if (!manages(await lockActor(tx, req.user, true)))
          fail(403, "Недостаточно прав");
        await validatePreparation(tx, d);
        const event = await getOne(
          tx,
          `INSERT INTO opportunities(title,description,city,format,starts_at,ends_at,
             status,skills,interests,location,capacity,visibility,cover_url,cover_alt,
             coordinator_id,required_course_id,application_deadline,preparation,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [...eventValues(d), req.user.id],
        );
        await audit(tx, req.user.id, "create", "opportunity", event.id);
        return event;
      });
      res.status(201).json({ item });
    }),
  );

  app.patch(
    "/api/opportunities/:id",
    requireRole("manager"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const item = await db.transaction(async (tx) => {
        if (!manages(await lockActor(tx, req.user, true)))
          fail(403, "Недостаточно прав");
        const previous = await lockEvent(tx, id);
        assertNotArchived(previous);
        const d = V.opportunity.parse({
          ...previous,
          starts_at: previous.starts_at
            ? new Date(previous.starts_at).toISOString()
            : null,
          ends_at: previous.ends_at
            ? new Date(previous.ends_at).toISOString()
            : null,
          application_deadline: previous.application_deadline
            ? new Date(previous.application_deadline).toISOString()
            : null,
          ...req.body,
        });
        await validatePreparation(tx, d, previous);
        const accepted = await tx.query(
          "SELECT COUNT(*)::int AS count FROM applications WHERE opportunity_id=$1 AND status='accepted'",
          [id],
        );
        if (d.capacity && d.capacity < accepted.rows[0].count)
          fail(409, "Лимит меньше числа подтверждённых участников");
        if (
          previous.visibility === "public" &&
          d.visibility === "invite_only"
        ) {
          const { rows } = await tx.query(
            `SELECT a.id FROM applications a
             WHERE a.opportunity_id=$1 AND a.status IN ('pending','accepted')
               AND NOT EXISTS (
                 SELECT 1 FROM opportunity_invitations i
                 WHERE i.opportunity_id=a.opportunity_id AND i.user_id=a.user_id AND i.status='active'
               ) LIMIT 1`,
            [id],
          );
          if (rows.length)
            fail(
              409,
              "Сначала пригласите волонтёров с действующими откликами или отклоните их отклики",
            );
        }
        const event = await getOne(
          tx,
          `UPDATE opportunities SET title=$1,description=$2,city=$3,format=$4,
             starts_at=$5,ends_at=$6,status=$7,skills=$8,interests=$9,
             location=$10,capacity=$11,visibility=$12,cover_url=$13,cover_alt=$14,
             coordinator_id=$15,required_course_id=$16,application_deadline=$17,preparation=$18 WHERE id=$19 RETURNING *`,
          [...eventValues(d), id],
        );
        if (event.status !== "draft")
          await enqueueEventNotification(tx, event, "applicants");
        await audit(tx, req.user.id, "update", "opportunity", id);
        return event;
      });
      res.json({ item });
    }),
  );

  for (const action of ["archive", "restore"]) {
    app.post(
      `/api/opportunities/:id/${action}`,
      requireRole("manager"),
      wrap(async (req, res) => {
        const id = V.id.parse(req.params.id);
        const item = await db.transaction(async (tx) => {
          const actor = await lockActor(tx, req.user, true);
          if (!manages(actor)) fail(403, "Недостаточно прав");
          const previous = await lockEvent(tx, id);
          if (Boolean(previous.archived_at) === (action === "archive"))
            return previous;
          const event = await getOne(
            tx,
            action === "archive"
              ? "UPDATE opportunities SET archived_at=NOW(),archived_by=$2,status=CASE WHEN status='draft' THEN 'draft' ELSE 'closed' END WHERE id=$1 RETURNING *"
              : "UPDATE opportunities SET archived_at=NULL,archived_by=NULL,status=CASE WHEN status='draft' THEN 'draft' ELSE 'closed' END WHERE id=$1 RETURNING *",
            action === "archive" ? [id, actor.id] : [id],
          );
          await audit(tx, actor.id, action, "opportunity", id);
          return event;
        });
        res.json({ item });
      }),
    );
  }

  app.get(
    "/api/opportunities/:id/participants",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const paging = pagination(req.query);
      const q = V.text(120).parse(req.query.q || "");
      const status = req.query.status
        ? z
            .enum(["pending", "accepted", "rejected", "withdrawn"])
            .parse(req.query.status)
        : null;
      const from = `FROM applications a JOIN users u ON u.id=a.user_id
        WHERE a.opportunity_id=$1 AND ($2::boolean OR u.role='volunteer')
          AND ($3='' OR u.full_name ILIKE $3 OR u.email ILIKE $3)
          AND ($4::text IS NULL OR a.status=$4)`;
      const result = await readSnapshot(db, async (tx) => {
        await getOne(tx, "SELECT id FROM opportunities WHERE id=$1", [id]);
        return queryPage(tx, {
          paging,
          values: [id, manages(req.user), q ? `%${q}%` : "", status],
          countSql: `SELECT COUNT(*) AS count ${from}`,
          itemsSql: ({ limit, offset }) => `WITH page AS MATERIALIZED (
            SELECT a.id AS application_id,a.opportunity_id,a.user_id,a.status,a.note,a.created_at,
              u.full_name,u.email,u.phone ${from}
            ORDER BY a.created_at,a.id LIMIT ${limit} OFFSET ${offset}
          ) SELECT page.*,
            (SELECT COALESCE(SUM(p.hours),0) FROM participation p
              WHERE p.user_id=page.user_id AND p.opportunity_id=page.opportunity_id) AS hours,
            (SELECT COUNT(*)::int FROM training_completions c JOIN training_materials m ON m.id=c.material_id
              WHERE c.user_id=page.user_id AND m.required AND m.published) AS required_completed,
            (SELECT COUNT(*)::int FROM training_materials WHERE required AND published) AS required_total
            FROM page ORDER BY page.created_at,page.application_id`,
        });
      });
      res.json(result);
    }),
  );

  app.get(
    "/api/opportunities/:id/invitations",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const paging = pagination(req.query);
      const q = V.text(120).parse(req.query.q || "");
      const status = req.query.status
        ? z.enum(["active", "revoked"]).parse(req.query.status)
        : null;
      const selection = `${invitationSelect}
        AND ($3='' OR u.full_name ILIKE $3 OR u.email ILIKE $3)
        AND ($4::text IS NULL OR i.status=$4)`;
      const result = await readSnapshot(db, async (tx) => {
        await getOne(tx, "SELECT id FROM opportunities WHERE id=$1", [id]);
        return queryPage(tx, {
          paging,
          values: [id, manages(req.user), q ? `%${q}%` : "", status],
          countSql: `SELECT COUNT(*) AS count FROM (${selection}) invitations`,
          itemsSql: `${selection} ORDER BY i.created_at,i.id`,
        });
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/opportunities/:id/invitations",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const { user_ids } = z
        .object({ user_ids: z.array(V.id).min(1).max(100) })
        .parse(req.body);
      const userIds = [...new Set(user_ids)].sort((a, b) => a - b);
      const result = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        const event = await lockEvent(tx, id);
        assertNotArchived(event);
        const volunteers = await tx.query(
          "SELECT id FROM users WHERE id=ANY($1::bigint[]) AND role='volunteer' AND status IN ('new','active') ORDER BY id FOR SHARE",
          [userIds],
        );
        if (volunteers.rows.length !== userIds.length)
          fail(409, "Приглашать можно только новых и активных волонтёров");
        let invitedCount = 0;
        for (const userId of userIds) {
          const { rows } = await tx.query(
            `INSERT INTO opportunity_invitations(opportunity_id,user_id,invited_by)
             VALUES($1,$2,$3)
             ON CONFLICT(opportunity_id,user_id) DO UPDATE
               SET status='active',invited_by=EXCLUDED.invited_by,updated_at=NOW(),revoked_at=NULL
               WHERE opportunity_invitations.status='revoked'
             RETURNING *`,
            [id, userId, req.user.id],
          );
          if (!rows.length) continue;
          invitedCount += 1;
          if (event.status === "open")
            await notify(tx, userId, "Приглашение на мероприятие", event.title);
          await audit(
            tx,
            req.user.id,
            "invite",
            "opportunity_invitation",
            rows[0].id,
          );
        }
        const { rows } = await tx.query(
          `${invitationSelect} AND i.user_id=ANY($3::bigint[]) ORDER BY i.created_at,i.id`,
          [id, manages(actor), userIds],
        );
        return { items: rows, invited_count: invitedCount };
      });
      res.status(201).json(result);
    }),
  );

  app.patch(
    "/api/opportunities/:id/invitations/:userId",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const userId = V.id.parse(req.params.userId);
      z.object({ status: z.literal("revoked") }).parse(req.body);
      const item = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user, true);
        const event = await lockEvent(tx, id);
        assertNotArchived(event);
        const target = await getOne(
          tx,
          "SELECT id,role FROM users WHERE id=$1 FOR SHARE",
          [userId],
          "Приглашение не найдено",
        );
        if (!manages(actor) && target.role !== "volunteer")
          fail(404, "Приглашение не найдено");
        const invitation = await getOne(
          tx,
          "SELECT * FROM opportunity_invitations WHERE opportunity_id=$1 AND user_id=$2 FOR UPDATE",
          [id, userId],
          "Приглашение не найдено",
        );
        if (invitation.status !== "revoked") {
          const conflict = await tx.query(
            `SELECT EXISTS (
               SELECT 1 FROM applications WHERE opportunity_id=$1 AND user_id=$2 AND status='accepted'
             ) OR EXISTS (
               SELECT 1 FROM participation WHERE opportunity_id=$1 AND user_id=$2
             ) AS blocked`,
            [id, userId],
          );
          if (conflict.rows[0].blocked)
            fail(
              409,
              "Сначала отзовите или отклоните подтверждённый отклик. При учтённом участии отзыв приглашения недоступен",
            );
          const applications = await tx.query(
            "UPDATE applications SET status='withdrawn' WHERE opportunity_id=$1 AND user_id=$2 AND status='pending' RETURNING id",
            [id, userId],
          );
          for (const application of applications.rows)
            await audit(
              tx,
              req.user.id,
              "withdraw_invitation",
              "application",
              application.id,
            );
          await tx.query(
            "UPDATE opportunity_invitations SET status='revoked',updated_at=NOW(),revoked_at=NOW() WHERE id=$1",
            [invitation.id],
          );
          if (event.status !== "draft")
            await notify(tx, userId, "Приглашение отозвано", event.title);
          await audit(
            tx,
            req.user.id,
            "revoke",
            "opportunity_invitation",
            invitation.id,
          );
        }
        return getOne(tx, `${invitationSelect} AND i.user_id=$3`, [
          id,
          manages(actor),
          userId,
        ]);
      });
      res.json({ item });
    }),
  );

  app.post(
    "/api/opportunities/:id/apply",
    auth,
    wrap(async (req, res) => {
      if (req.user.role !== "volunteer")
        fail(403, "Откликаться могут волонтёры");
      const id = V.id.parse(req.params.id);
      const d = z.object({ note: V.text(1000).optional() }).parse(req.body);
      const application = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        if (actor.role !== "volunteer")
          fail(403, "Откликаться могут волонтёры");
        const event = await lockEvent(tx, id);
        if (
          event.archived_at ||
          event.status !== "open" ||
          (event.visibility === "invite_only" &&
            !(await hasInvitation(tx, id, req.user.id)))
        )
          fail(404, "Мероприятие недоступно для записи");
        if (event.ends_at && new Date(event.ends_at) < new Date())
          fail(409, "Приём заявок завершён");
        if (event.application_deadline) {
          const deadline = await tx.query(
            "SELECT $1::timestamptz<=clock_timestamp() AS expired",
            [event.application_deadline],
          );
          if (deadline.rows[0].expired)
            fail(409, "Срок приёма заявок завершён");
        }
        await requireEventTraining(tx, event, actor);
        const { rows } = await tx.query(
          "SELECT * FROM applications WHERE opportunity_id=$1 AND user_id=$2",
          [id, req.user.id],
        );
        if (rows[0] && rows[0].status !== "withdrawn")
          fail(409, "Вы уже откликнулись");
        const a = await getOne(
          tx,
          `INSERT INTO applications(user_id,opportunity_id,note) VALUES($1,$2,$3)
           ON CONFLICT(user_id,opportunity_id) DO UPDATE SET status='pending',note=EXCLUDED.note
           RETURNING *`,
          [req.user.id, id, d.note || null],
        );
        await tx.query(
          "INSERT INTO notifications(user_id,title,body) SELECT id,$1,$2 FROM users WHERE role IN ('coordinator','manager','admin') AND status<>'closed'",
          ["Новый отклик", `${actor.full_name}: ${event.title}`],
        );
        await audit(tx, req.user.id, "apply", "application", a.id);
        return a;
      });
      res.status(201).json({ application });
    }),
  );

  // Own application history remains readable after an invitation is revoked.
  // Archiving preserves existing access; it never bypasses a revoked invitation.
  app.get(
    "/api/applications",
    auth,
    wrap(async (req, res) => {
      const paging = pagination(req.query);
      const dates = period(req.query);
      const opportunityId = req.query.opportunity_id
        ? V.id.parse(req.query.opportunity_id)
        : null;
      const status = req.query.status
        ? z
            .enum(["pending", "accepted", "rejected", "withdrawn"])
            .parse(req.query.status)
        : null;
      const userId = req.query.user_id ? V.id.parse(req.query.user_id) : null;
      const where = `WHERE ($1::boolean OR a.user_id=$2)
        AND ($3::bigint IS NULL OR a.opportunity_id=$3)
        AND ($4::text IS NULL OR a.status=$4)
        AND ($5::boolean OR u.role='volunteer')
        AND ($6::bigint IS NULL OR a.user_id=$6)
        AND ($7::date IS NULL OR a.created_at >= ($7::date::timestamp AT TIME ZONE 'UTC'))
        AND ($8::date IS NULL OR a.created_at < (($8::date + 1)::timestamp AT TIME ZONE 'UTC'))`;
      const values = [
        staff(req.user),
        req.user.id,
        opportunityId,
        status,
        req.user.role !== "coordinator",
        userId,
        dates.date_from,
        dates.date_to,
      ];
      const result = await readPage(db, {
        paging,
        values,
        countSql: `SELECT COUNT(*) AS count FROM applications a JOIN users u ON u.id=a.user_id ${where}`,
        itemsSql: `SELECT a.*,u.full_name,u.email,
           CASE WHEN $1::boolean OR (o.status<>'draft' AND (o.visibility='public' OR i.id IS NOT NULL))
             THEN o.title ELSE 'Закрытое мероприятие' END AS opportunity_title,
           CASE WHEN $1::boolean OR (o.status<>'draft' AND (o.visibility='public' OR i.id IS NOT NULL))
             THEN o.starts_at ELSE NULL END AS starts_at,
           o.archived_at AS opportunity_archived_at
         FROM applications a JOIN users u ON u.id=a.user_id
         JOIN opportunities o ON o.id=a.opportunity_id
         LEFT JOIN opportunity_invitations i
           ON i.opportunity_id=o.id AND i.user_id=a.user_id AND i.status='active'
         ${where} ORDER BY a.created_at DESC,a.id DESC`,
      });
      res.json(result);
    }),
  );

  app.patch(
    "/api/applications/:id",
    auth,
    wrap(async (req, res) => {
      const id = V.id.parse(req.params.id);
      const status = z
        .enum(["pending", "accepted", "rejected", "withdrawn"])
        .parse(req.body.status);
      const application = await db.transaction(async (tx) => {
        const actor = await lockActor(tx, req.user);
        const original = await getOne(
          tx,
          `SELECT a.* FROM applications a JOIN users u ON u.id=a.user_id
           WHERE a.id=$1 AND ($2::boolean OR u.role='volunteer')`,
          [id, actor.role !== "coordinator"],
        );
        if (
          !staff(actor) &&
          (String(original.user_id) !== String(actor.id) ||
            status !== "withdrawn")
        )
          fail(403, "Недостаточно прав");
        const event = await lockEvent(tx, original.opportunity_id);
        if (status === "pending" || status === "accepted")
          assertNotArchived(event);
        await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [
          original.user_id,
        ]);
        const a = await getOne(
          tx,
          "SELECT * FROM applications WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (
          (status === "pending" || status === "accepted") &&
          event.visibility === "invite_only" &&
          !(await hasInvitation(tx, event.id, a.user_id))
        )
          fail(409, "Для этого мероприятия необходимо действующее приглашение");
        if (a.status === status) return a;
        if (status === "accepted") {
          if (event.status !== "open") fail(409, "Мероприятие закрыто");
          const volunteer = await assertVolunteer(tx, a.user_id);
          if (volunteer.status === "closed")
            fail(409, "Аккаунт волонтёра закрыт");
          await requireEventTraining(tx, event, volunteer);
          const { rows } = await tx.query(
            "SELECT COUNT(*)::int AS count FROM applications WHERE opportunity_id=$1 AND status='accepted'",
            [event.id],
          );
          if (event.capacity && rows[0].count >= event.capacity)
            fail(409, "Свободных мест больше нет");
        }
        if (status !== "accepted") {
          const { rows } = await tx.query(
            "SELECT id FROM participation WHERE user_id=$1 AND opportunity_id=$2",
            [a.user_id, event.id],
          );
          if (rows.length)
            fail(409, "Участие уже учтено. Изменение отклика недоступно");
        }
        const result = await getOne(
          tx,
          "UPDATE applications SET status=$1 WHERE id=$2 RETURNING *",
          [status, id],
        );
        const labels = {
          accepted: "Подтверждён",
          rejected: "Отклонён",
          pending: "На рассмотрении",
          withdrawn: "Отозван",
        };
        // Resolving an old application must not reveal later private edits to
        // someone whose invitation has already been revoked.
        const accessible =
          event.status !== "draft" &&
          (event.visibility === "public" ||
            (await hasInvitation(tx, event.id, a.user_id)));
        await notify(
          tx,
          a.user_id,
          "Статус отклика изменён",
          accessible
            ? `${event.title}: ${labels[status]}`
            : `Ваш отклик: ${labels[status]}`,
        );
        await audit(tx, req.user.id, "change_status", "application", id);
        return result;
      });
      res.json({ application });
    }),
  );
}

module.exports = { registerOpportunityRoutes };
