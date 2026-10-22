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
process.env.REGISTRATION_ENABLED = "true";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS =
  "admin-demo@example.test,volunteer-demo@example.test";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { resetPassword } = require("../src/reset-password");
const V = require("../src/validation");
const {
  createVerificationCode,
  isDemoEmailAccount,
} = require("../src/verification-code");
const { csvCell } = require("../src/exports");
const { analyzeQuestion } = require("../src/assistant-knowledge");

test("Security regressions: dates, concurrent privileges, operator recovery", async (t) => {
  await migrate();
  let beforeTransaction;
  const guardedDb = {
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
  const server = createApp({
    db: guardedDb,
    mailer: { available: false },
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const suffix = crypto.randomBytes(6).toString("hex");
  const password = "Secure-" + crypto.randomBytes(12).toString("hex");
  const hash = await bcrypt.hash(password, 12);
  async function person(role, name) {
    const email = `${name}-${suffix}@example.test`;
    const { rows } = await database.query(
      "INSERT INTO users(full_name,email,password_hash,role,status,birth_date) VALUES($1,$2,$3,$4,'active','1997-05-12') RETURNING id",
      [name, email, hash, role],
    );
    let cookie = "",
      csrf = "";
    async function call(path, method = "GET", body, token = csrf) {
      const response = await fetch(base + path, {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length)
        cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      const data = response.status === 204 ? null : await response.json();
      if (data?.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    }
    await call("/auth/csrf");
    assert.equal(
      (await call("/auth/login", "POST", { email, password })).status,
      200,
    );
    return { id: rows[0].id, email, call };
  }
  const a = await person("admin", "first-admin"),
    b = await person("admin", "second-admin");
  const c = await person("coordinator", "coordinator"),
    v = await person("volunteer", "volunteer");
  const manager = await person("manager", "manager");
  async function guest() {
    let cookie = "",
      csrf = "";
    const call = async (path, method = "GET", body) => {
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
    await call("/auth/csrf");
    return { call };
  }
  await t.test(
    "unknown and closed accounts never create login challenges",
    async () => {
      const visitor = await guest();
      const unknown = `missing-${suffix}@example.test`;
      for (const endpoint of ["/auth/login-code/request", "/auth/login"]) {
        const result = await visitor.call(endpoint, "POST", {
          email: unknown,
          password,
        });
        assert.equal(result.status, 404);
        assert.equal(result.data.code, "account_not_found");
      }
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT COUNT(*) AS count FROM pending_login_codes",
            )
          ).rows[0].count,
        ),
        0,
      );
      await database.query("UPDATE users SET status='closed' WHERE id=$1", [
        v.id,
      ]);
      for (const endpoint of ["/auth/login-code/request", "/auth/login"]) {
        const result = await visitor.call(endpoint, "POST", {
          email: v.email,
          password,
        });
        assert.equal(result.status, 403);
        assert.equal(result.data.code, "account_unavailable");
      }
      await database.query("UPDATE users SET status='active' WHERE id=$1", [
        v.id,
      ]);
    },
  );
  await t.test(
    "demo OTP works only for exact existing accounts without marking email verified",
    async () => {
      const email = "volunteer-demo@example.test";
      await database.query(
        "INSERT INTO users(full_name,email,password_hash,status) VALUES('Test volunteer',$1,$2,'active')",
        [email, hash],
      );
      const visitor = await guest();
      const request = await visitor.call("/auth/login-code/request", "POST", {
        email,
      });
      assert.equal(request.status, 202);
      assert.equal(request.data.delivery, "demo");
      assert.equal(request.data.demo_code, "1234");
      assert.equal(
        (
          await database.query(
            "SELECT code_ciphertext FROM pending_login_codes",
          )
        ).rows[0].code_ciphertext,
        null,
      );
      const verified = await visitor.call("/auth/login-code/verify", "POST", {
        email,
        code: "1234",
      });
      assert.equal(verified.status, 200);
      assert.equal(verified.data.user.email_demo_account, true);
      assert.equal(verified.data.user.email_verified_at, null);
      const otherBrowser = await guest();
      assert.equal(
        (
          await otherBrowser.call("/auth/login-code/verify", "POST", {
            email,
            code: "1234",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await otherBrowser.call("/auth/password-reset/request", "POST", {
            email,
          })
        ).data.code,
        "demo_password_recovery_disabled",
      );
      assert.equal(isDemoEmailAccount("another@example.test"), false);
      assert.equal(isDemoEmailAccount("admin@another.local"), false);
      const regular = await otherBrowser.call(
        "/auth/login-code/request",
        "POST",
        { email: c.email },
      );
      assert.equal(regular.status, 503);
      assert.equal(regular.data.demo_code, undefined);
    },
  );
  await t.test(
    "revoked privilege is rechecked inside legacy write transaction",
    async () => {
      beforeTransaction = () =>
        database.query("UPDATE users SET role='volunteer' WHERE id=$1", [c.id]);
      const result = await c.call("/training", "POST", {
        title: "Must not persist",
      });
      assert.equal(result.status, 403);
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT COUNT(*) AS count FROM training_materials WHERE title='Must not persist'",
            )
          ).rows[0].count,
        ),
        0,
      );
      await database.query("UPDATE users SET role='coordinator' WHERE id=$1", [
        c.id,
      ]);
    },
  );
  await t.test(
    "coordinator cannot modify staff participation by guessing its ID",
    async () => {
      const entry = (
        await database.query(
          "INSERT INTO participation(user_id,title,hours) VALUES($1,'Historical staff entry',1) RETURNING id",
          [manager.id],
        )
      ).rows[0];
      assert.equal(
        (await c.call(`/participation/${entry.id}`, "PATCH", { hours: 2 }))
          .status,
        404,
      );
      assert.equal(
        Number(
          (
            await database.query(
              "SELECT hours FROM participation WHERE id=$1",
              [entry.id],
            )
          ).rows[0].hours,
        ),
        1,
      );
      assert.equal(
        (
          await manager.call(`/participation/${entry.id}`, "PATCH", {
            hours: 2,
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "closed session cannot write a profile after middleware authentication",
    async () => {
      const profile = await person("volunteer", "closing-profile");
      beforeTransaction = () =>
        database.query(
          "UPDATE users SET status='closed',auth_version=auth_version+1 WHERE id=$1",
          [profile.id],
        );
      const result = await profile.call("/me", "PATCH", {
        full_name: "Stale change",
      });
      assert.equal(result.status, 401);
      assert.equal(
        (
          await database.query("SELECT full_name FROM users WHERE id=$1", [
            profile.id,
          ])
        ).rows[0].full_name,
        "closing-profile",
      );
    },
  );
  await t.test(
    "DATE is an exact calendar string independent of process timezone",
    async () => {
      const result = await v.call("/me");
      assert.equal(result.data.user.birth_date, "1997-05-12");
      const details = await c.call(`/users/${v.id}`);
      assert.equal(details.data.user.birth_date, undefined);
      assert.equal(details.data.user.password_hash, undefined);
    },
  );
  await t.test("a multibyte CSRF header fails safely", async () => {
    // Latin-1 header with 64 characters but 128 UTF-8 bytes used to reach timingSafeEqual with unequal buffers.
    const result = await v.call(
      "/me",
      "PATCH",
      { full_name: "Attempt" },
      "é".repeat(64),
    );
    assert.equal(result.status, 403);
  });
  await t.test(
    "concurrent administrators cannot use revoked rights to demote each other",
    async () => {
      const results = await Promise.all([
        a.call(`/users/${b.id}/role`, "PATCH", { role: "volunteer" }),
        b.call(`/users/${a.id}/role`, "PATCH", { role: "volunteer" }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
      const { rows } = await database.query(
        "SELECT COUNT(*)::int AS count FROM users WHERE id IN ($1,$2) AND role='admin'",
        [a.id, b.id],
      );
      assert.equal(rows[0].count, 1);
    },
  );
  await t.test(
    "a closed volunteer cannot be accepted into an event",
    async () => {
      const made = await manager.call("/opportunities", "POST", {
        title: "Security event",
        description: "Approval regression scenario",
      });
      assert.equal(made.status, 201);
      const applied = await v.call(
        `/opportunities/${made.data.item.id}/apply`,
        "POST",
        {},
      );
      assert.equal(applied.status, 201);
      await c.call(`/users/${v.id}/status`, "PATCH", { status: "closed" });
      const accepted = await c.call(
        `/applications/${applied.data.application.id}`,
        "PATCH",
        { status: "accepted" },
      );
      assert.equal(accepted.status, 409);
      assert.equal((await v.call("/me")).status, 401);
    },
  );
  await t.test(
    "operator password recovery invalidates active sessions",
    async () => {
      process.env.RESET_EMAIL = c.email;
      process.env.RESET_PASSWORD =
        "New-" + crypto.randomBytes(15).toString("hex");
      await resetPassword();
      assert.equal((await c.call("/me")).status, 401);
      const { rows } = await database.query(
        "SELECT COUNT(*)::int AS count FROM audit_log WHERE subject_id=$1 AND action='operator_password_reset'",
        [c.id],
      );
      assert.equal(rows[0].count, 1);
    },
  );
});

test("reserved OTP, precise timestamps, CSV formulas and assistant scope", () => {
  for (let index = 0; index < 20000; index++) {
    const code = createVerificationCode({ EMAIL_CODE_MODE: "random" });
    assert.match(code, /^\d{4}$/);
    assert.notEqual(code, "1234");
  }
  assert.equal(
    createVerificationCode({ EMAIL_CODE_MODE: "fixed_demo" }),
    "1234",
  );
  assert.doesNotThrow(() =>
    V.opportunity.parse({
      title: "Valid event",
      description: "Fractional seconds",
      starts_at: "2030-01-01T12:00:00Z",
      ends_at: "2030-01-01T12:00:00.001Z",
    }),
  );
  assert.throws(() =>
    V.opportunity.parse({
      title: "Invalid event",
      description: "Reversed time",
      starts_at: "2030-01-01T12:00:00.001Z",
      ends_at: "2030-01-01T12:00:00Z",
    }),
  );
  for (const value of ["=1+1", " +SUM(1,1)", "@cmd", "\t=1"])
    assert.ok(csvCell(value).startsWith("\"'"));
  const guest = {
    role: "guest",
    registrationAvailable: true,
    mailAvailable: true,
    demoCode: false,
  };
  const guide = analyzeQuestion(
    { message: "Как зарегистрироваться?", history: [] },
    guest,
  );
  assert.equal(guide.guide.answer.includes("1234"), false);
  const restricted = analyzeQuestion(
    { message: "Открой аналитику", history: [] },
    guest,
  );
  assert.equal(restricted.response.navigateTo, undefined);
  assert.ok(
    restricted.response.actions.every((action) => action.href !== "#analytics"),
  );
});
