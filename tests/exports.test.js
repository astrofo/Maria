const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = process.env.TEST_DATABASE_URL
  ? "postgres"
  : "pglite";
process.env.DATABASE_PATH = "memory://";
if (process.env.TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET = randomBytes(48).toString("hex");
process.env.SESSION_COOKIE_SECURE = "false";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS = "";
const { database } = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/passwords");

test("Streaming exports preserve group history, omit credentials and bind tickets to sessions", async (t) => {
  await migrate();
  const password = randomBytes(24).toString("hex");
  const passwordHash = await hashPassword(password);
  const email = `export-${randomUUID()}@example.test`;
  const admin = (
    await database.query(
      "INSERT INTO users(full_name,email,password_hash,role,status) VALUES('Export fixture',$1,$2,'admin','active') RETURNING id",
      [email, passwordHash],
    )
  ).rows[0].id;
  await database.query(
    `INSERT INTO users(full_name,email,password_hash,phone)
    SELECT 'Volunteer '||n,n||'-'||$1||'@example.test','unusable','+70000000000' FROM generate_series(1,450) n`,
    [randomUUID()],
  );
  const volunteer = (
    await database.query(
      "SELECT id FROM users WHERE role='volunteer' ORDER BY id LIMIT 1",
    )
  ).rows[0].id;
  const achievement = (
    await database.query("SELECT id FROM achievements WHERE slug='first_event'")
  ).rows[0].id;
  await database.query(
    "INSERT INTO user_achievements(user_id,achievement_id,awarded_by) VALUES($1,$2,$3)",
    [volunteer, achievement, admin],
  );
  const event = (
    await database.query(
      "INSERT INTO opportunities(title,description) VALUES('Export fixture','Local test') RETURNING id",
    )
  ).rows[0].id;
  const group = (
    await database.query(
      "SELECT id FROM group_threads WHERE opportunity_id=$1 AND kind='event'",
      [event],
    )
  ).rows[0].id;
  const clientId = randomUUID();
  const message = (
    await database.query(
      "INSERT INTO group_messages(group_id,sender_user_id,kind,body,client_id) VALUES($1,$2,'message','Exported message',$3) RETURNING id",
      [group, admin, clientId],
    )
  ).rows[0].id;
  await database.query(
    "INSERT INTO group_reads(group_id,user_id,last_read_id) VALUES($1,$2,$3)",
    [group, admin, message],
  );
  const server = createApp({
    db: database,
    mailer: { available: false },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login() {
    let cookie = "",
      csrf = "";
    const request = async (path, method = "GET", body) => {
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
      return response;
    };
    csrf = (await (await request("/api/auth/csrf")).json()).csrfToken;
    const response = await request("/api/auth/login", "POST", {
      email,
      password,
    });
    assert.equal(response.status, 200);
    csrf = (await response.json()).csrfToken;
    return request;
  }
  const request = await login(),
    otherSession = await login();
  const prepare = async (format) => {
    const response = await request("/api/admin/exports/prepare", "POST", {
      format,
      current_password: password,
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).download_url;
  };
  const url = await prepare("json");
  assert.equal((await otherSession(url)).status, 410);
  const response = await request(url);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.tables.users.length, 451); // Crosses multiple 200-row cursor chunks.
  assert.equal(data.tables.group_messages[0].body, "Exported message");
  assert.equal(data.tables.group_threads.length, 1);
  assert.equal(data.tables.group_reads[0].last_read_id, message);
  assert.equal(data.tables.achievements.length, 5);
  assert.equal(data.tables.user_achievements.length, 1);
  assert.equal(data.tables.user_achievements[0].achievement_id, achievement);
  assert.equal(data.tables.user_achievements[0].awarded_by, admin);
  assert.ok(
    data.tables.users.every(
      (user) =>
        !Object.hasOwn(user, "password_hash") &&
        !Object.hasOwn(user, "auth_version"),
    ),
  );
  assert.ok(
    data.tables.group_messages.every(
      (item) =>
        !Object.hasOwn(item, "client_id") && !Object.hasOwn(item, "source_key"),
    ),
  );
  assert.equal(JSON.stringify(data).includes(passwordHash), false);
  assert.equal(JSON.stringify(data).includes(clientId), false);
  assert.equal((await request(url)).status, 410);
  const csvResponse = await request(await prepare("csv"));
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.equal(csv.trim().split("\r\n").length, 451);
  assert.equal((csv.match(/"ФИО"/g) || []).length, 1);
  assert.ok(csv.includes('"\'+70000000000"'));

  if (process.env.TEST_DATABASE_URL) {
    // The PostgreSQL run also exercises the actual pg_dump binary in the image.
    const backup = await request(await prepare("backup"));
    assert.equal(backup.status, 200);
    const bytes = Buffer.from(await backup.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "PGDMP");
    const toc = execFileSync("pg_restore", ["--list"], {
      input: bytes,
    }).toString();
    assert.match(toc, /TABLE DATA public group_messages/);
    assert.doesNotMatch(
      toc,
      /TABLE DATA public (sessions|pending_login_codes|pending_email_registrations|password_reset_requests)\s/,
    );
  }
});
