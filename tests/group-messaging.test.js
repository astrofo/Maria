const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = process.env.TEST_DATABASE_URL
  ? "postgres"
  : "pglite";
process.env.DATABASE_PATH = "memory://";
if (process.env.TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.SESSION_COOKIE_SECURE = "false";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS = "";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");

test("Event groups: current membership, private conversations and reliable announcements", async (t) => {
  await migrate();
  let beforeTransaction;
  const db = {
    ...database,
    async transaction(fn) {
      if (beforeTransaction) {
        const action = beforeTransaction;
        beforeTransaction = null;
        await action();
      }
      return database.transaction(fn);
    },
  };
  const server = createApp({ db, mailer: { available: false } }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const suffix = crypto.randomBytes(6).toString("hex");
  const password = "Group-test-" + crypto.randomBytes(12).toString("hex");
  const passwordHash = await bcrypt.hash(password, 12);
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, method = "GET", body) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length)
        cookie = cookies.map((value) => value.split(";")[0]).join("; ");
      const data = response.status === 204 ? null : await response.json();
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
  }
  async function person(role, name) {
    const email = `${name}-${suffix}@example.test`;
    const { rows } = await database.query(
      "INSERT INTO users(full_name,email,password_hash,role,status) VALUES($1,$2,$3,$4,'active') RETURNING id",
      [name, email, passwordHash, role],
    );
    const call = client();
    await call("/auth/csrf");
    assert.equal(
      (await call("/auth/login", "POST", { email, password })).status,
      200,
    );
    return { id: rows[0].id, call };
  }
  const admin = await person("admin", "group-admin"),
    manager = await person("manager", "group-manager"),
    assigned = await person("coordinator", "assigned-coordinator"),
    creator = await person("coordinator", "creator-coordinator"),
    outsider = await person("coordinator", "outside-coordinator"),
    first = await person("volunteer", "first-member"),
    second = await person("volunteer", "second-member"),
    pending = await person("volunteer", "pending-member");
  async function event({ visibility = "public", status = "open" } = {}) {
    const { rows } = await database.query(
      `INSERT INTO opportunities(title,description,status,visibility,created_by,coordinator_id,starts_at)
      VALUES($1,'Совместное мероприятие',$2,$3,$4,$5,NOW()+INTERVAL '7 days') RETURNING id`,
      [
        `Групповое событие ${suffix}`,
        status,
        visibility,
        creator.id,
        assigned.id,
      ],
    );
    const eventId = rows[0].id;
    const group = (
      await database.query(
        "SELECT id FROM group_threads WHERE opportunity_id=$1 AND kind='event'",
        [eventId],
      )
    ).rows[0];
    assert.ok(group);
    return { id: eventId, group: group.id };
  }
  const open = await event(),
    privateEvent = await event({ visibility: "invite_only" }),
    draft = await event({ status: "draft" });
  async function application(user, item, status = "accepted") {
    await database.query(
      "INSERT INTO applications(user_id,opportunity_id,status) VALUES($1,$2,$3) ON CONFLICT(user_id,opportunity_id) DO UPDATE SET status=EXCLUDED.status",
      [user.id, item.id, status],
    );
  }
  for (const user of [first, second]) await application(user, open);
  await application(pending, open, "pending");
  await application(first, privateEvent);
  await application(first, draft);
  const send = (
    user,
    group,
    body,
    kind = "message",
    clientId = crypto.randomUUID(),
  ) =>
    user.call(`/groups/${group}/messages`, "POST", {
      body,
      kind,
      client_id: clientId,
    });
  const messageCount = async (group) =>
    Number(
      (
        await database.query(
          "SELECT count(*) AS count FROM group_messages WHERE group_id=$1",
          [group],
        )
      ).rows[0].count,
    );

  await t.test(
    "event groups are automatic, paginated and hidden from nonmembers",
    async () => {
      const guest = client();
      assert.equal((await guest("/groups")).status, 401);
      const visible = await first.call("/groups?page_size=1");
      assert.equal(visible.status, 200);
      assert.equal(visible.data.page_size, 1);
      assert.equal(visible.data.items.length, 1);
      assert.equal(String(visible.data.items[0].id), String(open.group));
      for (const user of [pending, outsider]) {
        assert.equal(
          (await user.call(`/groups/events/${open.id}`)).status,
          404,
        );
        assert.equal(
          (await user.call(`/groups/${open.group}/messages`)).status,
          404,
        );
        assert.equal(
          (await user.call(`/groups/${open.group}/members`)).status,
          404,
        );
      }
      assert.equal(
        (await first.call(`/groups/events/${draft.id}`)).status,
        404,
      );
      for (const staff of [admin, manager, assigned, creator]) {
        const item = (await staff.call(`/groups/events/${open.id}`)).data.item;
        assert.equal(item.can_announce, true);
        const draftItem = (await staff.call(`/groups/events/${draft.id}`)).data
          .item;
        assert.equal(draftItem.read_only, true);
      }
      assert.equal((await first.call("/groups?page_size=101")).status, 400);
    },
  );

  await t.test(
    "member lists expose names and roles without profile contacts",
    async () => {
      const result = await first.call(
        `/groups/${open.group}/members?q=second&page_size=1`,
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.total, 1);
      assert.deepEqual(Object.keys(result.data.items[0]).sort(), [
        "full_name",
        "id",
        "role",
      ]);
      assert.equal(String(result.data.items[0].id), String(second.id));
      const members = (await first.call(`/groups/${open.group}/members`)).data
        .items;
      assert.ok(members.some((item) => String(item.id) === String(manager.id)));
      assert.ok(
        !members.some((item) => String(item.id) === String(pending.id)),
      );
    },
  );

  await t.test(
    "messages are idempotent, announcements restricted and unread is per recipient",
    async () => {
      const uuid = crypto.randomUUID();
      const sent = await send(
        first,
        open.group,
        "Первое сообщение",
        "message",
        uuid,
      );
      assert.equal(sent.status, 201);
      assert.equal(sent.data.message.is_mine, true);
      assert.equal(sent.data.message.client_id, undefined);
      assert.equal(
        (await send(first, open.group, "Первое сообщение", "message", uuid))
          .status,
        200,
      );
      assert.equal(
        (await send(first, open.group, "Изменённое сообщение", "message", uuid))
          .status,
        409,
      );
      assert.equal(
        (await send(second, open.group, "Первое сообщение", "message", uuid))
          .status,
        409,
      );
      assert.equal(
        (await send(first, open.group, "Объявление", "announcement")).status,
        403,
      );
      assert.equal(
        (
          await send(
            assigned,
            open.group,
            "Встречаемся у входа",
            "announcement",
          )
        ).status,
        201,
      );
      assert.equal(
        (await send(first, open.group, "Системное", "system")).status,
        400,
      );
      assert.equal(
        (
          await first.call(`/groups/${open.group}/messages`, "POST", {
            body: "Нет ключа",
          })
        ).status,
        400,
      );
      const unread = await second.call("/groups/unread-count");
      assert.equal(unread.data.unread, 2);
      const history = await second.call(`/groups/${open.group}/messages`);
      assert.equal(history.data.items.length, 2);
      assert.equal(history.data.items[1].kind, "announcement");
      assert.equal(history.data.items[0].is_mine, false);
      const last = history.data.items.at(-1).id;
      assert.equal(
        (
          await second.call(`/groups/${open.group}/read`, "POST", {
            message_id: last,
          })
        ).status,
        200,
      );
      assert.equal((await second.call("/groups/unread-count")).data.unread, 0);
      await second.call(`/groups/${open.group}/read`, "POST", {
        message_id: sent.data.message.id,
      });
      assert.equal((await second.call("/groups/unread-count")).data.unread, 0);
      const unseen = (await first.call("/groups/unread-count")).data.unread;
      assert.equal(unseen, 1);
      await send(first, open.group, "Ответ без прочтения истории");
      assert.equal(
        (await first.call("/groups/unread-count")).data.unread,
        unseen,
      );
    },
  );

  await t.test(
    "simultaneous retries create one message and coordinator members cannot announce",
    async () => {
      const uuid = crypto.randomUUID();
      const before = await messageCount(open.group);
      const responses = await Promise.all([
        send(first, open.group, "Повтор после обрыва", "message", uuid),
        send(first, open.group, "Повтор после обрыва", "message", uuid),
      ]);
      assert.deepEqual(
        responses.map((result) => result.status).sort(),
        [200, 201],
      );
      assert.equal(
        String(responses[0].data.message.id),
        String(responses[1].data.message.id),
      );
      assert.equal(await messageCount(open.group), before + 1);
      await application(outsider, open);
      assert.equal(
        (await outsider.call(`/groups/events/${open.id}`)).data.item
          .can_announce,
        false,
      );
      assert.equal(
        (await send(outsider, open.group, "Привет участникам")).status,
        201,
      );
      assert.equal(
        (await send(outsider, open.group, "Чужое объявление", "announcement"))
          .status,
        403,
      );
      await application(outsider, open, "withdrawn");
    },
  );

  let direct;
  await t.test(
    "direct conversations require a shared event and are private even from admins",
    async () => {
      assert.equal(
        (
          await first.call(`/groups/${open.group}/direct`, "POST", {
            user_id: pending.id,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await first.call(`/groups/${open.group}/direct`, "POST", {
            user_id: first.id,
          })
        ).status,
        400,
      );
      const created = await first.call(`/groups/${open.group}/direct`, "POST", {
        user_id: second.id,
      });
      assert.equal(created.status, 201);
      direct = created.data.item.id;
      assert.equal(created.data.item.kind, "direct");
      assert.equal(String(created.data.item.peer.id), String(second.id));
      const retry = await second.call(`/groups/${open.group}/direct`, "POST", {
        user_id: first.id,
      });
      assert.equal(retry.status, 200);
      assert.equal(String(retry.data.item.id), String(direct));
      assert.equal((await send(first, direct, "Личное сообщение")).status, 201);
      assert.equal(
        (await send(first, direct, "Объявление", "announcement")).status,
        403,
      );
      assert.equal(
        (
          await first.call(`/groups/${direct}/direct`, "POST", {
            user_id: manager.id,
          })
        ).status,
        400,
      );
      const adminUnread = (await admin.call("/groups/unread-count")).data
        .unread;
      await send(second, direct, "Личный ответ");
      assert.equal(
        (await admin.call("/groups/unread-count")).data.unread,
        adminUnread,
      );
      for (const staff of [admin, manager, assigned]) {
        assert.equal(
          (await staff.call(`/groups/${direct}/messages`)).status,
          404,
        );
        assert.equal(
          (await staff.call(`/groups/${direct}/members`)).status,
          404,
        );
        assert.ok(
          !(await staff.call("/groups")).data.items.some(
            (item) => String(item.id) === String(direct),
          ),
        );
      }
      const privateMessage = (await first.call(`/groups/${direct}/messages`))
        .data.items[0];
      assert.equal(
        (
          await first.call(`/groups/${open.group}/read`, "POST", {
            message_id: privateMessage.id,
          })
        ).status,
        404,
      );
      assert.equal(
        (await first.call(`/groups/${direct}/members`)).data.total,
        2,
      );
    },
  );

  await t.test(
    "withdrawal removes group and direct access including unread counts",
    async () => {
      await application(first, open, "withdrawn");
      for (const group of [open.group, direct]) {
        assert.equal(
          (await first.call(`/groups/${group}/messages`)).status,
          404,
        );
        assert.equal((await send(first, group, "После выхода")).status, 404);
      }
      assert.equal(
        (await second.call(`/groups/${direct}/messages`)).status,
        404,
      );
      assert.equal((await first.call("/groups/unread-count")).data.unread, 0);
      assert.equal((await first.call("/groups")).data.total, 0);
      await application(first, open);
    },
  );

  await t.test(
    "invite-only membership requires an active invitation at read and send time",
    async () => {
      assert.equal(
        (await first.call(`/groups/events/${privateEvent.id}`)).status,
        404,
      );
      await database.query(
        "INSERT INTO opportunity_invitations(opportunity_id,user_id,invited_by) VALUES($1,$2,$3)",
        [privateEvent.id, first.id, admin.id],
      );
      assert.equal(
        (await first.call(`/groups/events/${privateEvent.id}`)).status,
        200,
      );
      beforeTransaction = () =>
        database.query(
          "UPDATE opportunity_invitations SET status='revoked' WHERE opportunity_id=$1 AND user_id=$2",
          [privateEvent.id, first.id],
        );
      assert.equal(
        (await send(first, privateEvent.group, "Уже отозвано")).status,
        404,
      );
      assert.equal(await messageCount(privateEvent.group), 0);
    },
  );

  await t.test(
    "fresh roles and account status override request middleware state",
    async () => {
      beforeTransaction = () =>
        database.query("UPDATE users SET role='volunteer' WHERE id=$1", [
          manager.id,
        ]);
      assert.equal(
        (await send(manager, open.group, "Потерял роль", "announcement"))
          .status,
        404,
      );
      await database.query("UPDATE users SET role='manager' WHERE id=$1", [
        manager.id,
      ]);
      beforeTransaction = () =>
        database.query(
          "UPDATE users SET auth_version=auth_version+1 WHERE id=$1",
          [outsider.id],
        );
      assert.equal((await outsider.call("/groups")).status, 401);
      await application(pending, open);
      beforeTransaction = () =>
        database.query("UPDATE users SET status='closed' WHERE id=$1", [
          pending.id,
        ]);
      assert.equal((await send(pending, open.group, "Закрыт")).status, 401);
    },
  );

  await t.test(
    "closed and archived groups keep history but reject all new conversations and messages",
    async () => {
      await database.query(
        "UPDATE opportunities SET status='closed' WHERE id=$1",
        [open.id],
      );
      for (const user of [first, admin]) {
        const result = await user.call(`/groups/${open.group}/messages`);
        assert.equal(result.status, 200);
        assert.equal(result.data.group.read_only, true);
        assert.equal(result.data.group.can_announce, false);
        assert.equal(
          (await send(user, open.group, "После закрытия")).status,
          409,
        );
      }
      assert.equal((await send(first, direct, "Закрытый диалог")).status, 409);
      assert.equal(
        (
          await first.call(`/groups/${open.group}/direct`, "POST", {
            user_id: manager.id,
          })
        ).status,
        409,
      );
      await database.query(
        "UPDATE opportunities SET status='open',archived_at=NOW() WHERE id=$1",
        [open.id],
      );
      assert.equal((await send(first, open.group, "Архив")).status, 409);
      assert.equal(
        (await first.call(`/groups/${open.group}/messages`)).data.group
          .read_only,
        true,
      );
      await database.query(
        "UPDATE opportunities SET archived_at=NULL WHERE id=$1",
        [open.id],
      );
    },
  );

  await t.test(
    "system announcements deduplicate reminders and mirror only queued event campaigns",
    async () => {
      const key = "reminder-test:" + suffix;
      const before = await messageCount(open.group);
      const a = await database.query(
        "SELECT append_group_system_message($1,$2,$3) AS id",
        [open.id, key, "Скоро встреча"],
      );
      const b = await database.query(
        "SELECT append_group_system_message($1,$2,$3) AS id",
        [open.id, key, "Скоро встреча"],
      );
      assert.equal(String(a.rows[0].id), String(b.rows[0].id));
      assert.equal(await messageCount(open.group), before + 1);
      const campaign = (
        await database.query(
          `INSERT INTO message_campaigns(created_by,client_id,title,body,kind,opportunity_id)
      VALUES($1,$2,'Объявление рассылки','Полный текст','event',$3) RETURNING id`,
          [admin.id, crypto.randomUUID(), open.id],
        )
      ).rows[0];
      assert.equal(await messageCount(open.group), before + 1);
      await database.query(
        "UPDATE message_campaigns SET status='queued',sent_by=$2 WHERE id=$1",
        [campaign.id, admin.id],
      );
      await database.query(
        "UPDATE message_campaigns SET status='sending' WHERE id=$1",
        [campaign.id],
      );
      assert.equal(await messageCount(open.group), before + 2);
      const mirror = (
        await database.query(
          "SELECT body,kind FROM group_messages WHERE group_id=$1 AND source_key=$2",
          [open.group, "campaign:" + campaign.id],
        )
      ).rows[0];
      assert.equal(mirror.body, "Объявление рассылки\n\nПолный текст");
      assert.equal(mirror.kind, "system");
      await database.query(
        "UPDATE message_campaigns SET status='sent' WHERE id=$1",
        [campaign.id],
      );
      await database.query(
        "UPDATE opportunities SET city='Новое место' WHERE id=$1",
        [open.id],
      );
      assert.equal(await messageCount(open.group), before + 3);
      await database.query(
        "UPDATE opportunities SET city='Новое место' WHERE id=$1",
        [open.id],
      );
      assert.equal(await messageCount(open.group), before + 3);
    },
  );

  await t.test(
    "history uses bounded cursors and rejects unrelated read receipts",
    async () => {
      await database.query(
        "SELECT append_group_system_message($1,'history:'||$2||':'||n::text,'Запись '||n::text) FROM generate_series(1,55) n",
        [open.id, suffix],
      );
      const latest = await first.call(`/groups/${open.group}/messages`);
      assert.equal(latest.data.items.length, 50);
      assert.equal(latest.data.has_more, true);
      assert.ok(
        Number(latest.data.items[0].id) < Number(latest.data.items[49].id),
      );
      const earliest = latest.data.items[0].id;
      const older = await first.call(
        `/groups/${open.group}/messages?before_id=${earliest}`,
      );
      assert.ok(
        older.data.items.every((item) => Number(item.id) < Number(earliest)),
      );
      const after = await first.call(
        `/groups/${open.group}/messages?after_id=${earliest}`,
      );
      assert.equal(after.data.items.length, 49);
      assert.equal(after.data.has_more, false);
      assert.equal(
        (
          await first.call(
            `/groups/${open.group}/messages?after_id=1&before_id=2`,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await first.call(`/groups/${open.group}/read`, "POST", {
            message_id: 999999999,
          })
        ).status,
        404,
      );
      assert.equal(latest.data.items[0].source_key, undefined);
    },
  );

  await t.test(
    "persistent sender limit survives moving between groups",
    async () => {
      await database.query(
        `INSERT INTO group_messages(group_id,sender_user_id,kind,body,client_id)
      SELECT $1,$2,'message','Лимит',md5($3||n::text)::uuid FROM generate_series(1,120) n`,
        [open.group, second.id, suffix],
      );
      assert.equal(
        (await send(second, direct, "За пределом лимита")).status,
        429,
      );
    },
  );
});
