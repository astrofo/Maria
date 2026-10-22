const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

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
process.env.FRONTEND_ORIGINS = "https://frontend.example.test";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/passwords");
const { runAutomation } = require("../src/automation");

test("Administrator awards: permissions, history, idempotency and manual-only issuance", async (t) => {
  await migrate(database);
  let beforeTransaction;
  let failAudit = false;
  const db = {
    ...database,
    async transaction(fn) {
      if (beforeTransaction) {
        const action = beforeTransaction;
        beforeTransaction = null;
        await action();
      }
      return database.transaction((tx) =>
        fn({
          ...tx,
          query(sql, values) {
            if (failAudit && sql.startsWith("INSERT INTO audit_log")) {
              failAudit = false;
              throw Object.assign(new Error("Local rollback fixture"), {
                status: 503,
              });
            }
            return tx.query(sql, values);
          },
        }),
      );
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
  const password = "Award-" + crypto.randomBytes(20).toString("hex");
  const passwordHash = await hashPassword(password);
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, method = "GET", body, token) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          "x-csrf-token": token ?? csrf,
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
  const ok = (result, status = 200) => {
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  };
  async function person(role, name) {
    const email = `${name}-${suffix}@example.test`;
    const user = (
      await database.query(
        "INSERT INTO users(full_name,email,password_hash,role,status) VALUES($1,$2,$3,$4,'active') RETURNING id",
        [name, email, passwordHash, role],
      )
    ).rows[0];
    const call = client();
    ok(await call("/auth/csrf"));
    ok(await call("/auth/login", "POST", { email, password }));
    return { id: user.id, call };
  }
  const admin = await person("admin", "award-admin");
  const secondAdmin = await person("admin", "award-second-admin");
  const manager = await person("manager", "award-manager");
  const coordinator = await person("coordinator", "award-coordinator");
  const volunteer = await person("volunteer", "award-volunteer");
  const other = await person("volunteer", "award-other");
  const manualOnly = await person("volunteer", "award-manual-only");
  const catalog = ok(await admin.call("/achievements")).items;
  const bySlug = Object.fromEntries(catalog.map((item) => [item.slug, item]));
  const grant = (actor, target, slug = "first_event", token) =>
    actor.call(
      `/users/${target.id}/achievements`,
      "POST",
      { achievement_id: bySlug[slug].id },
      token,
    );
  const revoke = (actor, target, slug = "first_event") =>
    actor.call(`/users/${target.id}/achievements/${bySlug[slug].id}`, "DELETE");
  const count = async (sql, values) =>
    Number((await database.query(sql, values)).rows[0].count);
  const noticeCount = (user) =>
    count(
      "SELECT count(*) AS count FROM notifications WHERE user_id=$1 AND title='Новое достижение'",
      [user.id],
    );
  const auditCount = (action, awardId) =>
    count(
      "SELECT count(*) AS count FROM audit_log WHERE action=$1 AND subject_type='user_achievement' AND subject_id=$2",
      [action, awardId],
    );

  await t.test(
    "catalog is authenticated, deterministic and separate from awarded badges",
    async () => {
      assert.equal((await client()("/achievements")).status, 401);
      assert.deepEqual(
        catalog.map(({ slug, rarity, icon }) => [slug, rarity, icon]),
        [
          ["first_event", "common", "spark"],
          ["first_training", "uncommon", "book"],
          ["team_player", "rare", "people"],
          ["helping_hands", "epic", "hands"],
          ["heart_of_team", "legendary", "heart"],
        ],
      );
      for (const item of catalog) {
        assert.deepEqual(Object.keys(item).sort(), [
          "description",
          "icon",
          "id",
          "rarity",
          "slug",
          "sort_order",
          "title",
        ]);
        assert.ok(!/[<>]/.test(item.title + item.description));
      }
      assert.deepEqual(ok(await volunteer.call("/me/achievements")), {
        items: [],
        total: 0,
      });
      assert.deepEqual(
        ok(await volunteer.call(`/users/${volunteer.id}/achievements`)),
        { items: [], total: 0 },
      );
      assert.deepEqual(
        ok(await coordinator.call(`/users/${coordinator.id}/achievements`)),
        { items: [], total: 0 },
      );
      assert.equal(
        (await volunteer.call(`/users/${other.id}/achievements`)).status,
        403,
      );
      assert.equal(
        (await coordinator.call(`/users/${manager.id}/achievements`)).status,
        403,
      );
      assert.equal(
        (await coordinator.call(`/users/${volunteer.id}/achievements`)).status,
        200,
      );
      assert.equal(
        (await manager.call(`/users/${admin.id}/achievements`)).status,
        200,
      );
      assert.equal(
        (await admin.call("/users/9000000000000000/achievements")).status,
        404,
      );
    },
  );

  await t.test(
    "only admins can grant and revoke, with validation and CSRF protection",
    async () => {
      for (const actor of [volunteer, coordinator, manager]) {
        assert.equal((await grant(actor, volunteer)).status, 403);
        assert.equal((await revoke(actor, volunteer)).status, 403);
      }
      assert.equal(
        (await grant(admin, volunteer, "first_event", "")).status,
        403,
      );
      assert.equal((await grant(admin, manager)).status, 409);
      assert.equal((await grant(admin, admin)).status, 409);
      assert.equal(
        (
          await admin.call(`/users/${volunteer.id}/achievements`, "POST", {
            achievement_id: 9000000000000000,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await admin.call(`/users/${volunteer.id}/achievements`, "POST", {
            achievement_id: catalog[0].id,
            title: "<img src=x onerror=alert(1)>",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await admin.call(`/users/${volunteer.id}/achievements`, "POST", {
            achievement_id: -1,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await admin.call("/users/invalid/achievements", "POST", {
            achievement_id: catalog[0].id,
          })
        ).status,
        400,
      );
      assert.equal((await grant(admin, { id: 9000000000000000 })).status, 404);
      assert.equal(await noticeCount(volunteer), 0);
    },
  );

  let firstAward;
  await t.test(
    "simultaneous grants create one award, one notice and one audit entry",
    async () => {
      const results = await Promise.all([
        grant(admin, volunteer),
        grant(secondAdmin, volunteer),
      ]);
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        [200, 201],
      );
      firstAward = results.find((result) => result.status === 201).data.item;
      const duplicate = results.find((result) => result.status === 200).data;
      assert.equal(duplicate.duplicate, true);
      assert.equal(String(duplicate.item.id), String(firstAward.id));
      assert.deepEqual(Object.keys(firstAward).sort(), [
        "achievement_id",
        "awarded_at",
        "description",
        "icon",
        "id",
        "rarity",
        "slug",
        "title",
      ]);
      assert.equal(ok(await grant(admin, volunteer)).duplicate, true);
      assert.equal(await noticeCount(volunteer), 1);
      assert.equal(await auditCount("award_achievement", firstAward.id), 1);
      const own = ok(await volunteer.call("/me/achievements"));
      assert.equal(own.total, 1);
      assert.equal(String(own.items[0].id), String(firstAward.id));
      assert.equal(
        ok(await manager.call(`/users/${volunteer.id}/achievements`)).total,
        1,
      );
    },
  );

  await t.test(
    "revocations are scoped and idempotent; reissuing preserves resolved audit history",
    async () => {
      ok(await revoke(admin, other), 204);
      assert.equal(ok(await volunteer.call("/me/achievements")).total, 1);
      const results = await Promise.all([
        revoke(admin, volunteer),
        revoke(secondAdmin, volunteer),
      ]);
      assert.ok(results.every((result) => result.status === 204));
      assert.equal(ok(await volunteer.call("/me/achievements")).total, 0);
      assert.equal(await auditCount("revoke_achievement", firstAward.id), 1);
      assert.equal(await noticeCount(volunteer), 1);
      const previous = (
        await database.query("SELECT * FROM user_achievements WHERE id=$1", [
          firstAward.id,
        ])
      ).rows[0];
      assert.ok(previous.revoked_at);
      assert.ok(
        [admin.id, secondAdmin.id]
          .map(String)
          .includes(String(previous.revoked_by)),
      );
      const again = ok(await grant(admin, volunteer), 201).item;
      assert.notEqual(String(again.id), String(firstAward.id));
      assert.equal(await auditCount("award_achievement", again.id), 1);
      assert.equal(await noticeCount(volunteer), 2);
      assert.equal(
        (
          await database.query("SELECT id FROM achievements WHERE id=$1", [
            again.achievement_id,
          ])
        ).rows.length,
        1,
      );
    },
  );

  await t.test(
    "concurrent grant and revoke have one consistent serial outcome",
    async () => {
      const target = await person("volunteer", "award-race-target");
      const original = ok(await grant(admin, target), 201).item;
      const [granted, revoked] = await Promise.all([
        grant(admin, target),
        revoke(secondAdmin, target),
      ]);
      assert.ok([200, 201].includes(granted.status));
      ok(revoked, 204);
      const replaced = granted.status === 201;
      const current = ok(await target.call("/me/achievements"));
      assert.equal(current.total, replaced ? 1 : 0);
      assert.equal(await noticeCount(target), replaced ? 2 : 1);
      assert.equal(await auditCount("revoke_achievement", original.id), 1);
      assert.equal(
        await count(
          "SELECT count(*) AS count FROM user_achievements WHERE user_id=$1",
          [target.id],
        ),
        replaced ? 2 : 1,
      );
      if (replaced) {
        assert.notEqual(String(granted.data.item.id), String(original.id));
        assert.equal(String(current.items[0].id), String(granted.data.item.id));
      } else {
        assert.equal(granted.data.duplicate, true);
        assert.equal(String(granted.data.item.id), String(original.id));
      }
    },
  );

  await t.test(
    "fresh actor privileges and recipient eligibility override middleware snapshots",
    async () => {
      beforeTransaction = () =>
        database.query("UPDATE users SET role='manager' WHERE id=$1", [
          secondAdmin.id,
        ]);
      assert.equal((await grant(secondAdmin, other)).status, 403);
      await database.query("UPDATE users SET role='admin' WHERE id=$1", [
        secondAdmin.id,
      ]);
      beforeTransaction = () =>
        database.query(
          "UPDATE users SET auth_version=auth_version+1 WHERE id=$1",
          [secondAdmin.id],
        );
      assert.equal((await revoke(secondAdmin, volunteer)).status, 401);
      assert.equal(ok(await volunteer.call("/me/achievements")).total, 1);
      beforeTransaction = () =>
        database.query("UPDATE users SET role='volunteer' WHERE id=$1", [
          coordinator.id,
        ]);
      assert.equal(
        (await coordinator.call(`/users/${volunteer.id}/achievements`)).status,
        403,
      );
      await database.query("UPDATE users SET role='coordinator' WHERE id=$1", [
        coordinator.id,
      ]);
      beforeTransaction = () =>
        database.query("UPDATE users SET status='closed' WHERE id=$1", [
          other.id,
        ]);
      assert.equal((await grant(admin, other)).status, 409);
      await database.query(
        "UPDATE users SET status='active',role='coordinator' WHERE id=$1",
        [other.id],
      );
      assert.equal((await grant(admin, other)).status, 409);
      await database.query("UPDATE users SET role='volunteer' WHERE id=$1", [
        other.id,
      ]);
      assert.equal(await noticeCount(other), 0);
    },
  );

  await t.test(
    "admin can correct awards after recipient closes or changes role",
    async () => {
      const award = ok(await grant(admin, other, "first_training"), 201).item;
      await database.query("UPDATE users SET status='closed' WHERE id=$1", [
        other.id,
      ]);
      ok(await revoke(admin, other, "first_training"), 204);
      assert.equal(await auditCount("revoke_achievement", award.id), 1);
      await database.query("UPDATE users SET status='active' WHERE id=$1", [
        other.id,
      ]);
      const promoted = ok(await grant(admin, other, "team_player"), 201).item;
      await database.query("UPDATE users SET role='admin' WHERE id=$1", [
        other.id,
      ]);
      ok(await revoke(admin, other, "team_player"), 204);
      assert.equal(await auditCount("revoke_achievement", promoted.id), 1);
      await database.query("UPDATE users SET role='volunteer' WHERE id=$1", [
        other.id,
      ]);
    },
  );

  await t.test(
    "audit failure rolls back the award and its notice",
    async () => {
      const before = await noticeCount(volunteer);
      failAudit = true;
      assert.equal(
        (await grant(admin, volunteer, "helping_hands")).status,
        503,
      );
      assert.equal(await noticeCount(volunteer), before);
      assert.equal(
        await count(
          "SELECT count(*) AS count FROM user_achievements WHERE user_id=$1 AND achievement_id=$2",
          [volunteer.id, bySlug.helping_hands.id],
        ),
        0,
      );
      ok(await grant(admin, volunteer, "helping_hands"), 201);
      assert.equal(await noticeCount(volunteer), before + 1);
    },
  );

  await t.test(
    "participation, automation and legacy ledger entries do not issue manual badges",
    async () => {
      await database.query(
        "INSERT INTO automation_ledger(event_key,kind,user_id) VALUES($1,'achievement',$2)",
        [`legacy-achievement:${suffix}`, manualOnly.id],
      );
      await database.query(
        "INSERT INTO participation(user_id,title,participated_on,hours) VALUES($1,'Legacy threshold fixture',CURRENT_DATE,50)",
        [manualOnly.id],
      );
      assert.equal(
        await count(
          "SELECT count(*) AS count FROM achievement_recheck_queue WHERE user_id=$1",
          [manualOnly.id],
        ),
        0,
      );
      const result = await runAutomation(database);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        await count(
          "SELECT count(*) AS count FROM user_achievements WHERE user_id=$1",
          [manualOnly.id],
        ),
        0,
      );
      assert.equal(await noticeCount(manualOnly), 0);
      assert.deepEqual(ok(await manualOnly.call("/me/achievements")), {
        items: [],
        total: 0,
      });
      const response = ok(await manualOnly.call("/achievements"));
      assert.equal(response.items.length, 5);
      assert.equal(response.total_hours, undefined);
      assert.ok(
        response.items.every(
          (item) => item.earned === undefined && item.progress === undefined,
        ),
      );
      assert.equal(
        await count(
          "SELECT count(*) AS count FROM automation_ledger WHERE event_key=$1",
          [`legacy-achievement:${suffix}`],
        ),
        1,
      );
    },
  );

  await t.test(
    "DELETE preflight permits only an explicitly allowed frontend origin",
    async () => {
      const preflight = (origin) =>
        fetch(base + `/users/${volunteer.id}/achievements/${catalog[0].id}`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "DELETE",
            "access-control-request-headers": "x-csrf-token",
          },
        });
      const allowed = await preflight("https://frontend.example.test");
      assert.equal(allowed.status, 204);
      assert.ok(
        allowed.headers
          .get("access-control-allow-methods")
          .split(/,\s*/)
          .includes("DELETE"),
      );
      assert.equal(
        (await preflight("https://untrusted.example.test")).status,
        403,
      );
    },
  );
});
