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
process.env.REGISTRATION_ENABLED = "true";
process.env.DEMO_MODE = "true";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS = "";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { startLoginCodeDelivery } = require("../src/login-code");
const password = "Test-pass-" + crypto.randomBytes(12).toString("hex");
const deliveredCodes = new Map();
const loginCodes = new Map();
const mailer = {
  available: true,
  async sendVerification({ email, code }) {
    if (email.startsWith("undeliverable-"))
      throw new Error("mock_delivery_failure");
    deliveredCodes.set(email, code);
  },
  async sendLoginCode({ email, code }) {
    loginCodes.set(email, code);
  },
};

function client(base) {
  let cookie = "",
    csrfToken = "";
  const send = async (path, method = "GET", body, withCsrf = true) => {
    const headers = { cookie };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withCsrf && csrfToken) headers["x-csrf-token"] = csrfToken;
    const response = await fetch(base + "/api" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length)
      cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data };
  };
  return {
    send,
    async csrf() {
      const result = await send("/auth/csrf");
      assert.equal(result.status, 200);
      csrfToken = result.data.csrfToken;
    },
    async register(name, email) {
      await this.csrf();
      const result = await send("/auth/register", "POST", {
        full_name: name,
        email,
        password,
        rules_accepted: true,
        privacy_accepted: true,
      });
      assert.equal(result.status, 202, JSON.stringify(result.data));
      const verification = await send("/auth/verify-email", "POST", {
        email,
        code: deliveredCodes.get(email),
      });
      assert.equal(verification.status, 201, JSON.stringify(verification.data));
      await this.csrf();
      return verification.data.user;
    },
    async login(email, pass = password) {
      await this.csrf();
      const result = await send("/auth/login", "POST", {
        email,
        password: pass,
      });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      await this.csrf();
    },
  };
}
const ok = (result, status = 200) => {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
};

test("Volunteer portal: permissions and complete work cycle", async (t) => {
  await database.ready;
  await migrate(database);
  await migrate(database);
  const server = createApp({ db: database, mailer }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  });
  const anon = client(base),
    volunteer = client(base),
    other = client(base),
    coordinator = client(base),
    manager = client(base),
    admin = client(base);
  const suffix = crypto.randomBytes(5).toString("hex");
  const emails = Object.fromEntries(
    ["volunteer", "other", "coordinator", "manager", "admin"].map((role) => [
      role,
      `${role}-${suffix}@example.test`,
    ]),
  );
  const v = await volunteer.register("Анна Волонтёр", emails.volunteer);
  const v2 = await other.register("Борис Волонтёр", emails.other);
  const c = await coordinator.register("Ирина Координатор", emails.coordinator);
  const m = await manager.register("Елена Руководитель", emails.manager);
  const a = await admin.register("Ольга Администратор", emails.admin);
  for (const [user, role] of [
    [c, "coordinator"],
    [m, "manager"],
    [a, "admin"],
  ])
    await database.query("UPDATE users SET role=$1 WHERE id=$2", [
      role,
      user.id,
    ]);
  let event, application, secondApplication, entry, material;

  await t.test(
    "failed registration delivery creates no user and retires its code",
    async () => {
      const pending = client(base);
      await pending.csrf();
      const email = `undeliverable-${suffix}@example.test`;
      const response = await pending.send("/auth/register", "POST", {
        full_name: "Not registered",
        email,
        password,
        rules_accepted: true,
        privacy_accepted: true,
      });
      assert.equal(response.status, 503);
      assert.equal(response.data.code, "email_delivery_failed");
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT COUNT(*) AS count FROM users WHERE email=$1",
              [email],
            )
          ).rows[0].count,
        ),
        0,
      );
      const record = (
        await database.query(
          "SELECT send_status,code_hash FROM pending_email_registrations WHERE email=$1",
          [email],
        )
      ).rows[0];
      assert.equal(record.send_status, "failed");
      assert.equal(record.code_hash, null);
      assert.equal(
        (await pending.send("/auth/login-code/request", "POST", { email })).data
          .code,
        "account_not_found",
      );
    },
  );
  await t.test(
    "real login OTP uses durable delivery and is bound to its requesting browser",
    async () => {
      const login = client(base),
        stranger = client(base);
      await login.csrf();
      await stranger.csrf();
      const requested = ok(
        await login.send("/auth/login-code/request", "POST", {
          email: emails.volunteer,
        }),
        202,
      );
      assert.equal(requested.delivery, "email");
      assert.equal(requested.demo_code, undefined);
      const stop = startLoginCodeDelivery({
        db: database,
        mailer,
        intervalMs: 10,
      });
      try {
        const deadline = Date.now() + 3000;
        while (!loginCodes.has(emails.volunteer) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        await stop();
        const code = loginCodes.get(emails.volunteer);
        assert.match(code, /^\d{4}$/);
        assert.notEqual(code, "1234");
        assert.equal(
          (
            await stranger.send("/auth/login-code/verify", "POST", {
              email: emails.volunteer,
              code,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await login.send("/auth/login-code/verify", "POST", {
              email: emails.volunteer,
              code,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await database.query(
              "SELECT code_ciphertext FROM pending_login_codes",
            )
          ).rows[0].code_ciphertext,
          null,
        );
      } finally {
        await stop();
      }
    },
  );

  await t.test("unauthenticated and forged requests denied", async () => {
    assert.equal((await anon.send("/users")).status, 401);
    assert.equal((await volunteer.send("/users")).status, 403);
    assert.equal((await volunteer.send("/analytics")).status, 403);
    assert.equal(
      (await volunteer.send("/me", "PATCH", { full_name: "Forgery" }, false))
        .status,
      403,
    );
    const forged = await volunteer.send("/me", "PATCH", {
      full_name: "Анна Волонтёр",
      role: "admin",
    });
    assert.ok([200, 400].includes(forged.status));
    assert.equal(ok(await volunteer.send("/me")).user.role, "volunteer");
  });
  await t.test(
    "own profile persists; sensitive details are manager-only",
    async () => {
      ok(
        await volunteer.send("/me", "PATCH", {
          full_name: "Анна Волонтёр",
          city: "Москва",
          birth_date: "1997-05-12",
          skills: ["керамика"],
          interests: ["творчество"],
          phone: "+70000000000",
        }),
      );
      assert.equal(ok(await volunteer.send("/me")).user.city, "Москва");
      const operational = ok(await coordinator.send(`/users/${v.id}`)).user;
      assert.equal(operational.phone, "+70000000000");
      assert.equal(operational.birth_date, undefined);
      assert.ok(ok(await manager.send(`/users/${v.id}`)).user.birth_date);
      assert.equal((await volunteer.send(`/users/${v2.id}`)).status, 403);
      assert.equal((await coordinator.send(`/users/${a.id}`)).status, 403);
    },
  );
  await t.test(
    "drafts private, event published, matching available",
    async () => {
      event = ok(
        await manager.send("/opportunities", "POST", {
          title: "Творческая мастерская",
          description: "Помогаем участникам лепить из глины.",
          city: "Москва",
          skills: ["керамика"],
          interests: ["творчество"],
          status: "draft",
          capacity: 1,
        }),
        201,
      ).item;
      assert.equal(
        ok(await volunteer.send("/opportunities")).items.some(
          (item) => item.id === event.id,
        ),
        false,
      );
      ok(
        await manager.send(`/opportunities/${event.id}`, "PATCH", {
          status: "open",
        }),
      );
      const published = ok(await volunteer.send("/opportunities")).items.find(
        (item) => item.id === event.id,
      );
      assert.ok(published);
      assert.ok(Number(published.match_score) > 0);
      assert.equal(
        (
          await volunteer.send("/opportunities", "POST", {
            title: "Bad",
            description: "Bad",
          })
        ).status,
        403,
      );
    },
  );
  await t.test("applications isolated, accept capacity atomic", async () => {
    application = ok(
      await volunteer.send(`/opportunities/${event.id}/apply`, "POST", {
        note: "Готова помочь",
      }),
      201,
    ).application;
    secondApplication = ok(
      await other.send(`/opportunities/${event.id}/apply`, "POST", {}),
      201,
    ).application;
    assert.equal(
      (await volunteer.send(`/opportunities/${event.id}/apply`, "POST", {}))
        .status,
      409,
    );
    assert.equal(ok(await volunteer.send("/applications")).items.length, 1);
    assert.equal(
      (
        await volunteer.send(`/applications/${secondApplication.id}`, "PATCH", {
          status: "withdrawn",
        })
      ).status,
      403,
    );
    const attempts = await Promise.all(
      [application, secondApplication].map((ap) =>
        coordinator.send(`/applications/${ap.id}`, "PATCH", {
          status: "accepted",
        }),
      ),
    );
    assert.deepEqual(attempts.map((x) => x.status).sort(), [200, 409]);
    // Normalize which user got the single seat to make downstream checks deterministic.
    if (attempts[0].status !== 200) {
      ok(
        await coordinator.send(
          `/applications/${secondApplication.id}`,
          "PATCH",
          { status: "rejected" },
        ),
      );
      ok(
        await coordinator.send(`/applications/${application.id}`, "PATCH", {
          status: "accepted",
        }),
      );
    }
    const roster = ok(
      await coordinator.send(`/opportunities/${event.id}/participants`),
    ).items;
    assert.ok(
      roster.some(
        (item) =>
          String(item.user_id) === String(v.id) && item.status === "accepted",
      ),
    );
  });
  await t.test(
    "hours require accepted participant and cannot double count",
    async () => {
      const payload = {
        user_id: v.id,
        opportunity_id: event.id,
        title: event.title,
        participated_on: "2026-10-21",
        hours: 3.5,
      };
      entry = ok(
        await coordinator.send("/participation", "POST", payload),
        201,
      ).item;
      assert.equal(
        (await coordinator.send("/participation", "POST", payload)).status,
        409,
      );
      assert.ok(
        [400, 409].includes(
          (
            await coordinator.send("/participation", "POST", {
              ...payload,
              user_id: v2.id,
            })
          ).status,
        ),
      );
      assert.equal(ok(await other.send("/participation")).items.length, 0);
      assert.equal(
        Number(ok(await volunteer.send("/participation")).items[0].hours),
        3.5,
      );
      assert.equal(
        (await volunteer.send("/participation", "POST", payload)).status,
        403,
      );
      ok(
        await coordinator.send(`/participation/${entry.id}`, "PATCH", {
          hours: 4,
        }),
      );
      assert.equal(
        Number(ok(await manager.send("/analytics")).hours.total_hours),
        4,
      );
    },
  );
  await t.test(
    "training is private per person and repeat marking idempotent",
    async () => {
      material = ok(
        await coordinator.send("/training", "POST", {
          title: "Знакомство с фондом",
          description: "Вводный материал",
          url: "https://example.org/training",
          required: true,
          published: true,
        }),
        201,
      ).item;
      ok(await volunteer.send(`/training/${material.id}/complete`, "POST", {}));
      ok(await volunteer.send(`/training/${material.id}/complete`, "POST", {}));
      assert.equal(
        ok(await volunteer.send("/training")).items.find(
          (x) => x.id === material.id,
        ).completed,
        true,
      );
      assert.equal(
        ok(await other.send("/training")).items.find(
          (x) => x.id === material.id,
        ).completed,
        false,
      );
      assert.equal(
        (
          await coordinator.send("/training", "POST", {
            title: "Invalid",
            url: "javascript:alert(1)",
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "staff notes, notifications and thanks obey access boundaries",
    async () => {
      assert.equal(
        (
          await coordinator.send(`/users/${v.id}/notes`, "POST", {
            body: "Internal",
          })
        ).status,
        403,
      );
      ok(
        await manager.send(`/users/${v.id}/notes`, "POST", {
          body: "Предпочитает субботние занятия",
        }),
        201,
      );
      assert.ok(!ok(await coordinator.send(`/users/${v.id}`)).notes);
      assert.equal(
        ok(await manager.send(`/users/${v.id}`)).notes.items.length,
        1,
      );
      ok(
        await coordinator.send(`/users/${v.id}/thanks`, "POST", {
          message: "Спасибо за помощь на мастерской!",
        }),
        201,
      );
      assert.equal(ok(await volunteer.send("/thanks")).items.length, 1);
      assert.equal(ok(await other.send("/thanks")).items.length, 0);
      const notifications = ok(await volunteer.send("/notifications")).items;
      assert.ok(notifications.length >= 2);
      assert.equal(
        (
          await other.send(
            `/notifications/${notifications[0].id}/read`,
            "PATCH",
            {},
          )
        ).status,
        404,
      );
      ok(
        await volunteer.send(
          `/notifications/${notifications[0].id}/read`,
          "PATCH",
          {},
        ),
      );
    },
  );
  await t.test("closed events preserve related volunteer history", async () => {
    ok(
      await manager.send(`/opportunities/${event.id}`, "PATCH", {
        status: "closed",
      }),
    );
    assert.ok(
      ok(await volunteer.send("/applications")).items.some(
        (item) => item.opportunity_id === event.id,
      ),
    );
    assert.equal(
      (await other.send(`/opportunities/${event.id}/apply`, "POST", {})).status,
      404,
    );
  });
  await t.test(
    "opportunity filters cover the full list and archives preserve history",
    async () => {
      const result = ok(
        await volunteer.send(
          "/opportunities?city=%D0%BC%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&skill=%D0%9A%D0%95%D0%A0%D0%90%D0%9C%D0%98%D0%9A%D0%90&sort=latest&page_size=1",
        ),
      );
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, event.id);
      assert.equal(
        (await volunteer.send("/opportunities?sort=DROP%20TABLE")).status,
        400,
      );
      assert.equal(
        (
          await volunteer.send(
            "/opportunities?date_from=2030-02-01&date_to=2030-01-01",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await coordinator.send(
            `/opportunities/${event.id}/archive`,
            "POST",
            {},
          )
        ).status,
        403,
      );
      ok(await manager.send(`/opportunities/${event.id}/archive`, "POST", {}));
      assert.equal(
        ok(await anon.send("/public/opportunities")).items.some(
          (item) => item.id === event.id,
        ),
        false,
      );
      assert.equal(
        ok(await volunteer.send("/applications")).items[0].opportunity_id,
        event.id,
      );
      assert.equal(
        ok(await manager.send("/opportunities?archived=true")).items.some(
          (item) => item.id === event.id,
        ),
        true,
      );
      assert.equal(
        (await volunteer.send("/opportunities?archived=true")).status,
        403,
      );
      ok(await manager.send(`/opportunities/${event.id}/restore`, "POST", {}));
    },
  );
  await t.test(
    "course lesson access, quiz keys and learner progress are isolated",
    async () => {
      const textId = crypto.randomUUID(),
        quizId = crypto.randomUUID(),
        questionId = crypto.randomUUID();
      const right = crypto.randomUUID(),
        wrong = crypto.randomUUID();
      const document = {
        title: "Вводный курс",
        description: "Материалы для волонтёров",
        cover_url: "/assets/course.png",
        cover_alt: "Обложка курса",
        order: "sequential",
        lessons: [
          {
            id: textId,
            title: "Знакомство",
            type: "text",
            body: "Прочитайте вводный материал",
          },
          {
            id: quizId,
            title: "Проверка",
            type: "quiz",
            attempt_limit: 2,
            questions: [
              {
                id: questionId,
                prompt: "Кому сообщить о вопросе?",
                options: [
                  { id: right, text: "Координатору" },
                  { id: wrong, text: "Никому" },
                ],
                correct_option_id: right,
                explanation: "Обратитесь к координатору",
              },
            ],
          },
        ],
      };
      const created = ok(
        await manager.send("/courses", "POST", { document }),
        201,
      ).item;
      assert.equal(
        (await volunteer.send(`/courses/${created.id}`)).status,
        404,
      );
      assert.equal(
        (await coordinator.send(`/courses/${created.id}/editor`)).status,
        403,
      );
      const published = ok(
        await manager.send(`/courses/${created.id}/publication`, "POST", {
          expected_version: created.version,
          published: true,
        }),
      ).item;
      const enrolled = ok(
        await volunteer.send(`/courses/${created.id}/enroll`, "POST", {}),
      ).item;
      assert.equal(enrolled.document.lessons[1].locked, true);
      assert.equal(enrolled.document.lessons[1].questions, undefined);
      assert.equal(
        (
          await volunteer.send(
            `/courses/${created.id}/lessons/${quizId}/quiz-start`,
            "POST",
            { revision: "0".repeat(64) },
          )
        ).status,
        403,
      );
      const read = ok(
        await volunteer.send(
          `/courses/${created.id}/lessons/${textId}/complete`,
          "POST",
          { revision: enrolled.document.lessons[0].revision },
        ),
      ).item;
      const quiz = read.document.lessons[1];
      assert.equal(quiz.locked, false);
      assert.equal(quiz.questions[0].correct_option_id, undefined);
      assert.equal(quiz.questions[0].explanation, undefined);
      const attempt = ok(
        await volunteer.send(
          `/courses/${created.id}/lessons/${quizId}/quiz-start`,
          "POST",
          { revision: quiz.revision },
        ),
      ).attempt;
      const submission = {
        revision: quiz.revision,
        attempt_id: attempt.id,
        answers: [{ question_id: questionId, option_id: right }],
      };
      const passed = ok(
        await volunteer.send(
          `/courses/${created.id}/lessons/${quizId}/quiz-submit`,
          "POST",
          submission,
        ),
      );
      assert.equal(passed.result.passed, true);
      assert.equal(passed.item.progress.finished, true);
      assert.deepEqual(
        ok(
          await volunteer.send(
            `/courses/${created.id}/lessons/${quizId}/quiz-submit`,
            "POST",
            submission,
          ),
        ).result,
        passed.result,
      );
      assert.equal(
        ok(await other.send(`/courses/${created.id}`)).item.progress.enrolled,
        false,
      );
      const archived = ok(
        await manager.send(`/courses/${created.id}/archive`, "POST", {
          expected_version: published.version,
        }),
      ).item;
      assert.equal(
        (await other.send(`/courses/${created.id}/enroll`, "POST", {})).status,
        404,
      );
      assert.equal(
        ok(await volunteer.send("/courses?history=true")).items.some(
          (item) => item.id === created.id,
        ),
        true,
      );
      ok(
        await manager.send(`/courses/${created.id}/restore`, "POST", {
          expected_version: archived.version,
        }),
      );
    },
  );
  await t.test(
    "chat history and read receipts cannot cross guest or member boundaries",
    async () => {
      await anon.csrf();
      const guestMessage = ok(
        await anon.send("/chat/messages", "POST", {
          body: "Вопрос гостя",
          guest_email: "guest@example.test",
          client_id: crypto.randomUUID(),
        }),
        201,
      );
      const stranger = client(base);
      await stranger.csrf();
      assert.equal(ok(await stranger.send("/chat")).thread, null);
      assert.equal(
        (
          await stranger.send("/chat/read", "POST", {
            message_id: guestMessage.message.id,
          })
        ).status,
        404,
      );
      const memberMessage = ok(
        await volunteer.send("/chat/messages", "POST", {
          body: "Личный вопрос",
          client_id: crypto.randomUUID(),
        }),
        201,
      );
      assert.equal(ok(await other.send("/chat")).thread, null);
      assert.equal(
        (
          await other.send("/chat/read", "POST", {
            message_id: memberMessage.message.id,
          })
        ).status,
        404,
      );
      assert.equal((await coordinator.send("/messages/threads")).status, 403);
      const reply = ok(
        await manager.send(
          `/messages/threads/${memberMessage.thread_id}/messages`,
          "POST",
          { body: "Ответ фонда", client_id: crypto.randomUUID() },
        ),
        201,
      );
      assert.equal(
        ok(await volunteer.send("/chat")).items.some(
          (item) => item.id === reply.message.id,
        ),
        true,
      );
      assert.equal(
        (await volunteer.send(`/messages/threads/${guestMessage.thread_id}`))
          .status,
        403,
      );
    },
  );
  await t.test(
    "optional questionnaire groups and later edits preserve submission status",
    async () => {
      const submitted = ok(
        await volunteer.send("/questionnaire", "PATCH", { submit: true }),
      );
      assert.ok(submitted.completed_at);
      const edited = ok(
        await volunteer.send("/questionnaire", "PATCH", {
          hobbies: ["Творчество"],
          submit: false,
        }),
      );
      assert.equal(edited.completed_at, submitted.completed_at);
      assert.equal(
        (await other.send(`/users/${v.id}/questionnaire`)).status,
        403,
      );
    },
  );
  await t.test(
    "role revocation immediate without re-login, admin protections",
    async () => {
      ok(
        await admin.send(`/users/${c.id}/role`, "PATCH", { role: "volunteer" }),
      );
      assert.equal((await coordinator.send("/users")).status, 403);
      assert.equal(
        (await manager.send(`/users/${v.id}/role`, "PATCH", { role: "admin" }))
          .status,
        403,
      );
      assert.equal(
        (
          await admin.send(`/users/${a.id}/role`, "PATCH", {
            role: "volunteer",
          })
        ).status,
        400,
      );
      assert.ok(ok(await admin.send("/audit")).items.length >= 5);
    },
  );
  await t.test("closed account loses access immediately", async () => {
    ok(
      await manager.send(`/users/${v2.id}/status`, "PATCH", {
        status: "closed",
      }),
    );
    assert.ok([401, 403].includes((await other.send("/me")).status));
  });
  await t.test("password change revokes another existing session", async () => {
    const duplicate = client(base);
    await duplicate.login(emails.volunteer);
    const replacement = "Updated-" + crypto.randomBytes(15).toString("hex");
    ok(
      await volunteer.send("/auth/change-password", "POST", {
        current_password: password,
        password: replacement,
      }),
    );
    assert.equal((await duplicate.send("/me")).status, 401);
    const fresh = client(base);
    await fresh.login(emails.volunteer, replacement);
    assert.equal(ok(await fresh.send("/me")).user.id, v.id);
  });
  await t.test(
    "malformed inputs handled without database internals",
    async () => {
      for (const value of ["bad-id", "-1", "1.5"])
        assert.equal((await manager.send(`/users/${value}`)).status, 400);
      const badDate = await manager.send("/opportunities", "POST", {
        title: "Invalid date",
        description: "Description",
        starts_at: "nonsense",
      });
      assert.equal(badDate.status, 400);
      assert.equal(
        JSON.stringify(badDate.data).includes("password_hash"),
        false,
      );
    },
  );
});
