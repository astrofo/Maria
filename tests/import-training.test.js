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
process.env.TRUST_PROXY = "0";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS = "reserved@example.test";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const {
  hashPassword,
  verifyPassword,
  hasPassword,
} = require("../src/passwords");
const bcrypt = require("bcryptjs");
const { volunteersCsv } = require("../src/exports");
const { questionnaireSchema } = require("../src/questionnaire");

test("Questionnaire import and required course admission", async (t) => {
  await database.ready;
  await migrate(database);
  const server = createApp({
    db: database,
    mailer: { available: false },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const suffix = crypto.randomBytes(5).toString("hex");
  const password = `Local-${crypto.randomBytes(20).toString("hex")}`;
  const passwordHash = await hashPassword(password);
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
        cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      const data = response.status === 204 ? null : await response.json();
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
  }
  const ok = (result, expected = 200) => {
    assert.equal(result.status, expected, JSON.stringify(result.data));
    return result.data;
  };
  async function person(role, name) {
    const email = `${name}-${suffix}@example.test`;
    const user = (
      await database.query(
        "INSERT INTO users(full_name,email,password_hash,role,status) VALUES($1,$2,$3,$4,'active') RETURNING *",
        [name, email, passwordHash, role],
      )
    ).rows[0];
    const call = client();
    ok(await call("/auth/csrf"));
    ok(await call("/auth/login", "POST", { email, password }));
    return { user, call };
  }
  const manager = await person("manager", "manager");
  const coordinator = await person("coordinator", "coordinator");
  const volunteer = await person("volunteer", "volunteer");
  const other = await person("volunteer", "other");
  const imported = `import-${suffix}@example.test`;
  const preview = (csv) =>
    manager.call("/questionnaire-import/preview", "POST", { csv });
  const apply = (preview_token, call = manager.call) =>
    call("/questionnaire-import/apply", "POST", {
      preview_token,
      confirm: true,
    });

  await t.test(
    "profiles distinguish supported passwords from imported placeholders",
    async () => {
      assert.equal(hasPassword(passwordHash), true);
      assert.equal(hasPassword(await bcrypt.hash(password, 4)), true);
      for (const hash of [
        null,
        "",
        "unknown",
        "disabled:imported:random",
        "$2b$12$broken",
        "scrypt$16384$8$1$bad$bad",
      ])
        assert.equal(hasPassword(hash), false);
      assert.equal(ok(await volunteer.call("/me")).user.has_password, true);
    },
  );

  await t.test(
    "preview is read-only and apply creates drafts without credentials or consent",
    async () => {
      const csv = `\uFEFFФИО;E-mail;Город;Навыки;Статус;E-mail подтверждён;role\r\n"Новый, участник";${imported.toUpperCase()};Москва;"Фото; Дизайн";active;2026-01-01;admin\r\nПовтор;${imported};;;;;\r\nСуществующий;${volunteer.user.email};;;;;`;
      const data = ok(await preview(csv));
      assert.deepEqual(data.summary, {
        total: 3,
        create: 1,
        skipped: 2,
        invalid: 0,
      });
      assert.equal(data.can_apply, true);
      assert.equal(
        (
          await database.query("SELECT id FROM users WHERE email=$1", [
            imported,
          ])
        ).rows.length,
        0,
      );
      assert.equal(
        (await apply(data.preview_token, coordinator.call)).status,
        403,
      );
      const anotherSession = client();
      ok(await anotherSession("/auth/csrf"));
      ok(
        await anotherSession("/auth/login", "POST", {
          email: manager.user.email,
          password,
        }),
      );
      assert.equal(
        (await apply(data.preview_token, anotherSession)).status,
        409,
      );
      assert.equal(
        (
          await manager.call("/questionnaire-import/apply", "POST", {
            preview_token: data.preview_token,
            confirm: false,
          })
        ).status,
        400,
      );
      assert.deepEqual(ok(await apply(data.preview_token)), {
        created: 1,
        skipped: 2,
        total: 3,
      });
      assert.equal((await apply(data.preview_token)).status, 409);
      const user = (
        await database.query("SELECT * FROM users WHERE email=$1", [imported])
      ).rows[0];
      assert.equal(user.role, "volunteer");
      assert.equal(user.status, "new");
      for (const field of [
        "email_verified_at",
        "rules_accepted_at",
        "privacy_accepted_at",
        "consent_version",
      ])
        assert.equal(user[field], null);
      assert.equal(await verifyPassword(password, user.password_hash), false);
      const profile = ok(await manager.call(`/users/${user.id}`)).user;
      assert.equal(profile.has_password, false);
      assert.equal(profile.password_hash, undefined);
      assert.deepEqual(user.skills, ["Фото", "Дизайн"]);
      assert.equal(
        (
          await database.query(
            "SELECT id FROM audit_log WHERE action='import_questionnaire' AND subject_id=$1",
            [user.id],
          )
        ).rows.length,
        1,
      );
    },
  );

  await t.test(
    "full exported CSV roundtrips questionnaire as unsubmitted draft",
    async () => {
      const email = `roundtrip-${suffix}@example.test`;
      const payload = questionnaireSchema.parse({
        hobbies: ["Искусство"],
        skills: [{ name: "Дизайн и графика", level: 3 }],
        help_directions: ["Фото, медиа, контент"],
        occupation: "work",
        occupation_field: "Дизайнер",
        has_volunteer_experience: false,
        has_professional_education: false,
        preferred_format: "mixed",
        availability: { sat: 2.5 },
      });
      const csv = volunteersCsv({
        tables: {
          users: [
            {
              id: 1,
              full_name: "Тест экспорта",
              email,
              gender: "unspecified",
              phone: "+79991234567",
              skills: ["Дизайн и графика"],
              interests: ["Фото, медиа, контент"],
            },
          ],
          volunteer_questionnaires: [
            { user_id: 1, payload, completed_at: "2025-01-01" },
          ],
        },
      });
      const data = ok(await preview(csv));
      assert.equal(data.summary.invalid, 0);
      ok(await apply(data.preview_token));
      const row = (
        await database.query(
          "SELECT u.phone,q.payload,q.completed_at FROM users u JOIN volunteer_questionnaires q ON q.user_id=u.id WHERE email=$1",
          [email],
        )
      ).rows[0];
      assert.equal(row.phone, "+79991234567");
      assert.deepEqual(row.payload, payload);
      assert.equal(row.completed_at, null);
    },
  );

  await t.test(
    "invalid rows and reserved demo addresses cannot be applied",
    async () => {
      const data = ok(
        await preview(
          "full_name,email,questionnaire_json\nBad,email,\nReserved,reserved@example.test,\nValid,valid@example.test,invalid-json",
        ),
      );
      assert.equal(data.summary.invalid, 3);
      assert.deepEqual(data.rows[0].errors, [
        "Некорректный адрес электронной почты.",
      ]);
      assert.equal(data.can_apply, false);
      assert.equal(data.preview_token, null);
      assert.equal(
        (await preview('full_name,email\n"broken,email')).status,
        400,
      );
      assert.equal(
        (
          await preview(
            "email,E-mail,full_name\na@example.test,b@example.test,Name",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await preview(
            "full_name,email\n" +
              Array.from(
                { length: 201 },
                (_, i) => `Name ${i},x${i}@example.test`,
              ).join("\n"),
          )
        ).status,
        400,
      );
      assert.equal(
        (await preview("full_name,email\n" + "a".repeat(512 * 1024))).status,
        400,
      );
      assert.equal(
        (
          await coordinator.call("/questionnaire-import/preview", "POST", {
            csv: "full_name,email\nName,new@example.test",
          })
        ).status,
        403,
      );
    },
  );

  await t.test(
    "account created after preview is skipped without overwrite; apply is single use",
    async () => {
      const email = `race-${suffix}@example.test`;
      const data = ok(await preview(`full_name,email\nImported,${email}`));
      await database.query(
        "INSERT INTO users(full_name,email,password_hash) VALUES('Original',$1,$2)",
        [email, passwordHash],
      );
      const results = await Promise.all([
        apply(data.preview_token),
        apply(data.preview_token),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.deepEqual(results.find((r) => r.status === 200).data, {
        created: 0,
        skipped: 1,
        total: 1,
      });
      assert.equal(
        (
          await database.query("SELECT full_name FROM users WHERE email=$1", [
            email,
          ])
        ).rows[0].full_name,
        "Original",
      );
    },
  );

  await t.test(
    "revoking manager access invalidates applying an earlier preview",
    async () => {
      const email = `revoked-${suffix}@example.test`;
      const data = ok(await preview(`full_name,email\nImported,${email}`));
      await database.query("UPDATE users SET role='volunteer' WHERE id=$1", [
        manager.user.id,
      ]);
      assert.equal((await apply(data.preview_token)).status, 403);
      assert.equal(
        (await database.query("SELECT id FROM users WHERE email=$1", [email]))
          .rows.length,
        0,
      );
      await database.query(
        "UPDATE users SET role='manager',auth_version=auth_version+1 WHERE id=$1",
        [manager.user.id],
      );
      assert.equal((await apply(data.preview_token)).status, 401);
      ok(await manager.call("/auth/csrf"));
      ok(
        await manager.call("/auth/login", "POST", {
          email: manager.user.email,
          password,
        }),
      );
      assert.equal((await apply(data.preview_token)).status, 409);
    },
  );

  await t.test(
    "Excel dates and quoted multiline fields retain their values",
    async () => {
      const email = `excel-${suffix}@example.test`;
      const data = ok(
        await preview(
          `ФИО;E-mail;Дата рождения;Пол;Опыт\nИмпорт Excel;${email};12.05.1997;Женский;"Первая строка\nВторая строка"`,
        ),
      );
      ok(await apply(data.preview_token));
      const row = (
        await database.query(
          "SELECT birth_date,gender,experience FROM users WHERE email=$1",
          [email],
        )
      ).rows[0];
      assert.equal(row.birth_date, "1997-05-12");
      assert.equal(row.gender, "female");
      assert.equal(row.experience, "Первая строка\nВторая строка");
    },
  );

  const lessonId = crypto.randomUUID();
  let course, event, pending;
  await t.test(
    "required course blocks applying and accepting an earlier application",
    async () => {
      course = ok(
        await manager.call("/courses", "POST", {
          document: {
            title: "Required preparation",
            description: "Foundation material",
            cover_url: "/assets/course.png",
            cover_alt: "Course",
            required: true,
            lessons: [
              {
                id: lessonId,
                title: "Preparation",
                type: "text",
                body: "Read this preparation",
              },
            ],
          },
        }),
        201,
      ).item;
      course = ok(
        await manager.call(`/courses/${course.id}/publication`, "POST", {
          expected_version: course.version,
          published: true,
        }),
      ).item;
      event = ok(
        await manager.call("/opportunities", "POST", {
          title: "Prepared event",
          description: "Needs current preparation",
          status: "open",
        }),
        201,
      ).item;
      pending = ok(
        await volunteer.call(`/opportunities/${event.id}/apply`, "POST", {}),
        201,
      ).application;
      ok(
        await manager.call(`/opportunities/${event.id}`, "PATCH", {
          required_course_id: course.id,
        }),
      );
      const blocked = await other.call(
        `/opportunities/${event.id}/apply`,
        "POST",
        {},
      );
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.code, "required_course_incomplete");
      assert.equal(Number(blocked.data.required_course_id), Number(course.id));
      const acceptance = await coordinator.call(
        `/applications/${pending.id}`,
        "PATCH",
        { status: "accepted" },
      );
      assert.equal(acceptance.status, 409);
      assert.equal(acceptance.data.code, "required_course_incomplete");
      const details = ok(
        await volunteer.call(`/opportunities/${event.id}`),
      ).item;
      assert.deepEqual(details.training_requirement, {
        course_id: Number(course.id),
        completed: false,
        available: true,
      });
      const analytics = ok(await manager.call("/analytics"));
      assert.equal(analytics.onboarding.required_courses, 1);
      assert.equal(analytics.onboarding.required_course_lessons, 1);
      assert.equal(analytics.onboarding.required_training_completed, 0);
      assert.equal(
        (
          await manager.call(`/courses/${course.id}/publication`, "POST", {
            expected_version: course.version,
            published: false,
          })
        ).status,
        409,
      );
    },
  );

  await t.test(
    "current lesson completion allows admission and is counted in analytics",
    async () => {
      let learning = ok(
        await volunteer.call(`/courses/${course.id}/enroll`, "POST", {}),
      ).item;
      ok(
        await volunteer.call(
          `/courses/${course.id}/lessons/${lessonId}/complete`,
          "POST",
          { revision: learning.document.lessons[0].revision },
        ),
      );
      assert.equal(
        ok(await manager.call("/analytics")).onboarding
          .required_training_completed,
        1,
      );
      assert.equal(
        ok(await volunteer.call(`/opportunities/${event.id}`)).item
          .training_requirement.completed,
        true,
      );
      ok(
        await coordinator.call(`/applications/${pending.id}`, "PATCH", {
          status: "accepted",
        }),
      );
      learning = ok(
        await other.call(`/courses/${course.id}/enroll`, "POST", {}),
      ).item;
      ok(
        await other.call(
          `/courses/${course.id}/lessons/${lessonId}/complete`,
          "POST",
          { revision: learning.document.lessons[0].revision },
        ),
      );
      ok(await other.call(`/opportunities/${event.id}/apply`, "POST", {}), 201);
      assert.equal(
        ok(await manager.call("/analytics")).onboarding
          .required_training_completed,
        2,
      );
    },
  );

  await t.test(
    "changed course contents invalidate completion in admission and analytics",
    async () => {
      const current = ok(
        await manager.call(`/courses/${course.id}/editor`),
      ).item;
      current.document.lessons[0].body =
        "Changed preparation that must be completed again";
      ok(
        await manager.call(`/courses/${course.id}`, "PATCH", {
          expected_version: current.version,
          document: current.document,
        }),
      );
      assert.equal(
        ok(await manager.call("/analytics")).onboarding
          .required_training_completed,
        0,
      );
      assert.equal(
        ok(await volunteer.call(`/opportunities/${event.id}`)).item
          .training_requirement.completed,
        false,
      );
      const fresh = ok(
        await manager.call("/opportunities", "POST", {
          title: "Second event",
          description: "Same required course",
          required_course_id: course.id,
        }),
        201,
      ).item;
      assert.equal(
        (await volunteer.call(`/opportunities/${fresh.id}/apply`, "POST", {}))
          .data.code,
        "required_course_incomplete",
      );
      // Admission already granted remains historical; recording actual work is not
      // a new admission and must remain possible after a curriculum revision.
      ok(
        await coordinator.call("/participation", "POST", {
          user_id: volunteer.user.id,
          opportunity_id: event.id,
          hours: 1,
        }),
        201,
      );
      const currentCourse = ok(
        await manager.call(`/courses/${course.id}/editor`),
      ).item;
      currentCourse.document.ends_at = "2020-01-01T00:00:00Z";
      ok(
        await manager.call(`/courses/${course.id}`, "PATCH", {
          expected_version: currentCourse.version,
          document: currentCourse.document,
        }),
      );
      assert.equal(
        (await volunteer.call(`/opportunities/${fresh.id}/apply`, "POST", {}))
          .data.code,
        "required_course_unavailable",
      );
    },
  );
});
