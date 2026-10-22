const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
process.env.NODE_ENV = "test";
process.env.DATABASE_MODE = "pglite";
process.env.DATABASE_PATH = "memory://";
process.env.SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.SESSION_COOKIE_SECURE = "false";
process.env.TRUST_PROXY = "0";
process.env.REGISTRATION_ENABLED = "true";
process.env.DEMO_MODE = "true";
process.env.EMAIL_CODE_MODE = "random";
process.env.EMAIL_DEMO_ACCOUNTS = "admin@demo.local,volunteer@demo.local";
process.env.DEMO_PASSWORD = "UI-test-" + crypto.randomBytes(12).toString("hex");
process.env.PUBLIC_ORIGIN = "";
process.env.FRONTEND_ORIGINS = "";
const { database } = require("../src/db");
const { seed } = require("../src/seed");
const { createApp } = require("../src/app");
const { openUI, fill, submit } = require("./helpers/dom");

async function navigate(ui, route, selector) {
  const previous = ui.document.querySelector("#content")?.firstElementChild;
  const changing = ui.window.location.hash !== `#${route}`;
  ui.window.location.hash = route;
  if (changing) await ui.waitFor(() => !previous?.isConnected);
  return ui.waitFor(selector);
}
async function until(fn) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error("Expected saved API state was not reached");
}
function otp(ui, code) {
  const cell = ui.document.querySelector('[data-otp="0"]');
  cell.value = code;
  cell.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
}

test("Current interface works with an isolated local API", async (t) => {
  await seed(database);
  const sent = [];
  const mailer = {
    available: true,
    sendVerification: async (message) =>
      sent.push({ ...message, kind: "registration" }),
    sendLoginCode: async (message) => sent.push({ ...message, kind: "login" }),
    sendPasswordReset: async (message) =>
      sent.push({ ...message, kind: "recovery" }),
  };
  const server = createApp({ mailer }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const windows = [];
  t.after(async () => {
    windows.forEach((ui) => ui.close());
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  });
  const open = async (options = {}) => {
    const ui = await openUI(base, options);
    windows.push(ui);
    return ui;
  };
  const login = async (email, options = {}) => {
    const ui = await open({ ...options, route: "#login" });
    await ui.waitFor("#auth-form");
    ui.document.querySelector('[data-action="login-method"]').click();
    fill(ui, "email", email);
    fill(ui, "password", process.env.DEMO_PASSWORD);
    submit(ui, "#auth-form");
    await ui.waitFor(".sidebar");
    await ui.waitFor("#content h1");
    return ui;
  };
  let volunteer, manager, coordinator, event;
  await t.test("home opens without a global code banner", async () => {
    const ui = await open();
    await ui.waitFor(".home-page");
    assert.equal(ui.document.querySelector(".demo-access-banner"), null);
    assert.ok(ui.document.querySelector('a[href="#register"]'));
    const hash = ui.window.location.hash;
    ui.document.querySelector(".skip-link").click();
    assert.equal(ui.window.location.hash, hash);
    assert.equal(ui.document.activeElement.id, "content");
  });
  await t.test(
    "unknown email stays on login and offers registration",
    async () => {
      const ui = await open({ route: "#login" });
      await ui.waitFor("#auth-form");
      fill(ui, "email", "not-created@example.test");
      submit(ui, "#auth-form");
      const link = await ui.waitFor(
        '#auth-form .form-error a[href="#register"]',
      );
      assert.match(link.parentElement.parentElement.textContent, /не найден/i);
      assert.equal(ui.document.querySelector("#login-verification-form"), null);
      assert.equal(sent.length, 0);
      link.click();
      await ui.waitFor('[data-auth-mode="registration"]');
      assert.equal(
        ui.document.querySelector('[name="email"]').value,
        "not-created@example.test",
      );
      await navigate(ui, "login", '[data-auth-mode="email-code"]');
      ui.document.querySelector('[data-action="login-method"]').click();
      fill(ui, "password", process.env.DEMO_PASSWORD);
      submit(ui, "#auth-form");
      await ui.waitFor('#auth-form .form-error a[href="#register"]');
    },
  );
  await t.test(
    "test account uses 1234 without mail or false verification",
    async () => {
      volunteer = await open({ route: "#login" });
      await volunteer.waitFor("#auth-form");
      fill(volunteer, "email", "volunteer@demo.local");
      submit(volunteer, "#auth-form");
      await volunteer.waitFor("#login-verification-form");
      assert.match(
        volunteer.document.querySelector(".auth-form").textContent,
        /1234/,
      );
      assert.equal(sent.length, 0);
      otp(volunteer, "1234");
      submit(volunteer, "#login-verification-form");
      await volunteer.waitFor(".sidebar");
      await navigate(volunteer, "profile", "#profile-form");
      const user = (await volunteer.api("/me")).user;
      assert.equal(user.email_demo_account, true);
      assert.equal(user.email_verified_at, null);
      assert.match(
        volunteer.document.querySelector(".profile-security").textContent,
        /почта не проверяется/,
      );
    },
  );
  await t.test(
    "registration delivers a random code and opens questionnaire",
    async () => {
      const ui = await open({ route: "#register" });
      await ui.waitFor('[data-auth-mode="registration"]');
      fill(ui, "first_name", "Тестовая");
      fill(ui, "last_name", "Регистрация");
      fill(ui, "email", "new-volunteer@example.test");
      fill(ui, "password", process.env.DEMO_PASSWORD);
      fill(ui, "repeat_password", process.env.DEMO_PASSWORD);
      fill(ui, "consent", true);
      submit(ui, "#auth-form");
      await ui.waitFor("#verification-form");
      const message = sent.find(
        (x) =>
          x.kind === "registration" && x.email === "new-volunteer@example.test",
      );
      assert.match(message.code, /^\d{4}$/);
      assert.notEqual(message.code, "1234");
      assert.doesNotMatch(
        ui.document.querySelector(".auth-form").textContent,
        /1234/,
      );
      otp(ui, message.code);
      submit(ui, "#verification-form");
      await ui.waitFor("#questionnaire-form");
      assert.equal((await ui.api("/me")).user.email_demo_account, false);
      assert.ok((await ui.api("/me")).user.email_verified_at);
      submit(ui, "#questionnaire-form", '[data-intent="draft"]');
      await ui.waitFor("#dialog[open]");
      assert.match(
        ui.document.querySelector("#dialog").textContent,
        /Черновик анкеты сохранён/,
      );
    },
  );
  await t.test(
    "profile saves current fields and role navigation is restricted",
    async () => {
      assert.equal(
        volunteer.document.querySelector('.sidebar a[href="#users"]'),
        null,
      );
      fill(volunteer, "first_name", "Анна");
      fill(volunteer, "last_name", "Проверенная");
      fill(volunteer, "phone", "+7 900 123-45-67");
      submit(volunteer, "#profile-form");
      await until(
        async () => (await volunteer.api("/me")).user.phone === "+79001234567",
      );
      manager = await login("manager@demo.local");
      coordinator = await login("coordinator@demo.local");
      assert.ok(
        manager.document.querySelector('.sidebar a[href="#analytics"]'),
      );
      assert.equal(
        coordinator.document.querySelector('.sidebar a[href="#analytics"]'),
        null,
      );
      await navigate(coordinator, "event-editor/new", ".org-empty");
      assert.match(
        coordinator.document.querySelector("#content").textContent,
        /нет доступа/,
      );
      assert.equal(coordinator.document.querySelector("#org-event-form"), null);
    },
  );
  await t.test(
    "manager publishes a three-step event with escaped user text",
    async () => {
      await navigate(manager, "event-editor/new", "#org-event-form");
      fill(manager, "title", "Проверка <img src=x onerror=alert(1)>");
      fill(
        manager,
        "description",
        "Совместное занятие для участников и волонтёров.",
      );
      fill(manager, "city", "Ярославль");
      fill(manager, "format", "Очно");
      fill(manager, "location", "Мастерская");
      const day = new Date(Date.now() + 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      fill(manager, "starts_at", `${day}T12:00`);
      fill(manager, "ends_at", `${day}T15:00`);
      manager.document
        .querySelector('[data-action="org-editor-step"][data-step="2"]')
        .click();
      await manager.waitFor('[name="capacity"]');
      await manager.waitFor(() =>
        [...manager.document.querySelectorAll(".lookup-picker select")].every(
          (select) => !select.disabled,
        ),
      );
      fill(manager, "capacity", "2");
      fill(manager, "skills", "Керамика");
      manager.document
        .querySelector('[data-action="org-editor-step"][data-step="3"]')
        .click();
      await manager.waitFor(
        '[data-action="org-save-event"][data-publish="true"]',
      );
      manager.document
        .querySelector('[data-action="org-save-event"][data-publish="true"]')
        .click();
      event = await until(async () =>
        (await manager.api("/opportunities")).items.find((x) =>
          x.title.startsWith("Проверка <img"),
        ),
      );
      await manager.waitFor("#org-events-filter");
      assert.equal(event.status, "open");
      assert.equal(manager.document.querySelector("[onerror]"), null);
    },
  );
  await t.test(
    "opportunity filters persist through details; applications and hours save",
    async () => {
      await navigate(volunteer, "opportunities", "#event-filter");
      fill(volunteer, "city", "Ярославль");
      fill(volunteer, "available", "true");
      submit(volunteer, "#event-filter");
      await volunteer.waitFor(
        () =>
          volunteer.document.querySelectorAll(".opportunity-card").length === 1,
      );
      volunteer.document.querySelector(".event-card-link").click();
      await volunteer.waitFor('[data-action="apply"]');
      volunteer.document.querySelector('[data-action="apply"]').click();
      await volunteer.waitFor("#dialog[open] #dialog-form");
      fill(volunteer, "note", "Готова помочь с материалами");
      submit(volunteer, "#dialog-form");
      const application = await until(async () =>
        (await volunteer.api("/applications")).items.find(
          (x) => String(x.opportunity_id) === String(event.id),
        ),
      );
      await navigate(
        manager,
        "applications",
        `[data-action="application-status"][data-id="${application.id}"][data-status="accepted"]`,
      );
      manager.document
        .querySelector(
          `[data-action="application-status"][data-id="${application.id}"][data-status="accepted"]`,
        )
        .click();
      await until(
        async () =>
          (await volunteer.api("/applications")).items.find(
            (x) => x.id === application.id,
          )?.status === "accepted",
      );
      await navigate(
        manager,
        `organizer-events/${event.id}`,
        '[data-action="event-hours"]',
      );
      manager.document.querySelector('[data-action="event-hours"]').click();
      await manager.waitFor("#dialog[open] #dialog-form");
      await manager.waitFor(() =>
        [
          ...manager.document.querySelectorAll("#dialog .lookup-picker select"),
        ].every((select) => !select.disabled),
      );
      fill(manager, "hours", "2.5");
      submit(manager, "#dialog-form");
      await until(async () =>
        (await volunteer.api("/participation")).items.some(
          (x) => Number(x.hours) === 2.5,
        ),
      );
      await navigate(volunteer, "opportunities", "#event-filter");
      assert.equal(
        volunteer.document.querySelector('[name="city"]').value,
        "Ярославль",
      );
    },
  );
  await t.test("event archive and restore preserve participation", async () => {
    manager.document
      .querySelector(`[data-action="org-archive-event"][data-id="${event.id}"]`)
      .click();
    await manager.waitFor("#dialog[open] #dialog-form");
    submit(manager, "#dialog-form");
    await until(
      async () =>
        (await manager.api(`/opportunities/${event.id}`)).item.archived_at,
    );
    assert.ok(
      (await volunteer.api("/participation")).items.some(
        (x) => String(x.opportunity_id) === String(event.id),
      ),
    );
    await navigate(
      manager,
      `organizer-events/${event.id}`,
      `[data-action="org-restore-event"][data-id="${event.id}"]`,
    );
    manager.document
      .querySelector(`[data-action="org-restore-event"][data-id="${event.id}"]`)
      .click();
    await manager.waitFor("#dialog[open] #dialog-form");
    submit(manager, "#dialog-form");
    await until(
      async () =>
        !(await manager.api(`/opportunities/${event.id}`)).item.archived_at,
    );
    assert.equal(
      (await manager.api(`/opportunities/${event.id}`)).item.status,
      "closed",
    );
  });
  await t.test(
    "legacy material completion works through the current course UI",
    async () => {
      const material = (await volunteer.api("/training")).items[0];
      await navigate(
        volunteer,
        `training/material/${material.id}`,
        '[data-pc-action="legacy-complete"]',
      );
      volunteer.document
        .querySelector('[data-pc-action="legacy-complete"]')
        .click();
      await until(
        async () =>
          (await volunteer.api(`/training/${material.id}`)).item.completed,
      );
      await navigate(volunteer, "training", "[data-pc-search]");
      assert.equal(volunteer.document.querySelector('a[href$="/null"]'), null);
    },
  );
  await t.test("notification action labels are text, not markup", async () => {
    const { user } = await volunteer.api("/me");
    const label = '<img src=x onerror="alert(1)">';
    await database.query(
      "INSERT INTO notifications(user_id,title,body,target_type,action_label) VALUES($1,$2,$3,$4,$5)",
      [
        user.id,
        "Сообщение команды",
        "Проверьте возможности",
        "opportunities",
        label,
      ],
    );
    await navigate(
      volunteer,
      "notifications",
      '[data-action="notification-open"]',
    );
    const button = volunteer.document.querySelector(
      '[data-action="notification-open"]',
    );
    assert.equal(button.textContent, label);
    assert.equal(button.querySelector("img"), null);
    assert.equal(volunteer.document.querySelector("[onerror]"), null);
  });
  await t.test(
    "a late successful code response does not replace a new screen",
    async () => {
      let release, accepted;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const ui = await open({
        route: "#login",
        fetchAdapter: async (target, options, send) => {
          const response = await send();
          if (target.endsWith("/auth/login-code/verify")) {
            accepted = response.ok;
            await gate;
          }
          return response;
        },
      });
      await ui.waitFor("#auth-form");
      fill(ui, "email", "admin@demo.local");
      submit(ui, "#auth-form");
      await ui.waitFor("#login-verification-form");
      otp(ui, "1234");
      const form = ui.document.querySelector("#login-verification-form");
      submit(ui, "#login-verification-form");
      await until(() => accepted);
      await navigate(ui, "home", ".home-page");
      release();
      await ui.waitFor(() => !form.dataset.pending);
      assert.equal(ui.window.location.hash, "#home");
      assert.ok(ui.document.querySelector(".home-page"));
      assert.equal(ui.document.querySelector(".sidebar"), null);
    },
  );
  await t.test(
    "course drafts can be created, filtered, archived and restored",
    async () => {
      await navigate(manager, "training/new", "[data-pc-new]");
      fill(manager, "title", "Курс для проверки корзины");
      fill(manager, "description", "Знакомство с фондом и работой команды");
      submit(manager, "[data-pc-new]");
      await manager.waitFor("[data-pc-save-status]");
      const id = manager.window.location.hash.split("/")[2];
      assert.match(id, /^\d+$/);
      await navigate(manager, "training", "[data-pc-search]");
      fill(manager, "q", "проверки корзины");
      submit(manager, "[data-pc-search]");
      await manager.waitFor(() =>
        manager.document.querySelector(".pc-count").textContent.includes("1"),
      );
      manager.window.confirm = () => true;
      manager.document
        .querySelector(
          `[data-pc-action="archive-course"][data-course-id="${id}"]`,
        )
        .click();
      await until(
        async () =>
          (await manager.api(`/courses/${id}/editor`)).item.archived_at,
      );
      await manager.waitFor(
        () =>
          !manager.document.querySelector('[data-pc-action="archive-course"]'),
      );
      fill(manager, "archived", "true");
      submit(manager, "[data-pc-search]");
      await manager.waitFor(
        `[data-pc-action="restore-course"][data-course-id="${id}"]`,
      );
      manager.document
        .querySelector(
          `[data-pc-action="restore-course"][data-course-id="${id}"]`,
        )
        .click();
      await until(
        async () =>
          !(await manager.api(`/courses/${id}/editor`)).item.archived_at,
      );
    },
  );
  await t.test("task details follow the filtered list", async () => {
    await navigate(manager, "staff-tasks", "#org-tasks-filter");
    manager.document.querySelector('[data-action="org-new-task"]').click();
    await manager.waitFor('#dialog[open] [name="task_user"]');
    await manager.waitFor(() =>
      [
        ...manager.document.querySelectorAll("#dialog .lookup-picker select"),
      ].every((select) => !select.disabled),
    );
    fill(manager, "title", "Познакомиться с новым волонтёром");
    fill(manager, "task_user", (await volunteer.api("/me")).user.id);
    submit(manager, "#dialog-form");
    await manager.waitFor(
      () =>
        !manager.document.querySelector("#dialog[open]") &&
        manager.document.querySelector(".org-task-detail h3"),
    );
    assert.match(
      manager.document.querySelector(".org-task-detail").textContent,
      /Познакомиться с новым волонтёром/,
    );
    fill(manager, "status", "done");
    submit(manager, "#org-tasks-filter");
    await manager.waitFor(() =>
      manager.document
        .querySelector(".org-task-list")
        ?.textContent.includes("Задач не найдено"),
    );
    assert.equal(manager.document.querySelector(".org-task-detail h3"), null);
  });
  await t.test("phone menu manages focus and inert content", async () => {
    const ui = await login("volunteer@demo.local", { viewportWidth: 390 });
    const sidebar = ui.document.querySelector(".sidebar");
    const main = ui.document.querySelector(".main-column");
    assert.equal(sidebar.inert, true);
    ui.document
      .querySelector('[data-action="shell-menu"].shell-menu-button')
      .click();
    assert.equal(sidebar.inert, false);
    assert.equal(main.inert, true);
    assert.equal(sidebar.getAttribute("aria-modal"), "true");
    ui.document.dispatchEvent(
      new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    assert.equal(sidebar.inert, true);
    assert.equal(main.inert, false);
    assert.equal(
      ui.document
        .querySelector(".shell-menu-button")
        .getAttribute("aria-expanded"),
      "false",
    );
  });
  await t.test(
    "Kistik escapes model output and rejects unauthorized navigation",
    async () => {
      const ui = await open({
        route: "#kistik",
        fetchAdapter: (target, options, send) => {
          if (target.endsWith("/assistant/config"))
            return Response.json({
              enabled: true,
              examples: ["Где возможности?"],
            });
          if (target.endsWith("/assistant/chat"))
            return Response.json({
              answer: '<img src=x onerror="alert(1)"> Ответ помощника',
              mode: "model",
              navigateTo: "#access",
              actions: [
                { href: "#access", label: "Закрытый раздел" },
                { href: "javascript:alert(1)", label: "Опасная ссылка" },
                {
                  href: "#opportunities",
                  label: "Посмотреть <b>возможности</b>",
                },
              ],
              sources: [
                { href: "https://example.test", title: "Внешний адрес" },
              ],
            });
          return send();
        },
      });
      await ui.waitFor('[name="message"]:not(:disabled)');
      fill(ui, "message", "Где возможности?");
      submit(ui, "[data-pk-form]");
      await ui.waitFor(".pk-assistant");
      assert.equal(ui.window.location.hash, "#kistik");
      const reply = ui.document.querySelector(".pk-assistant");
      assert.equal(
        reply.querySelector(
          "[onerror],a[href^='javascript:'],a[href='#access']",
        ),
        null,
      );
      assert.equal(reply.querySelectorAll(".pk-actions a").length, 1);
      assert.equal(
        reply.querySelector(".pk-actions a").textContent,
        "Посмотреть <b>возможности</b>",
      );
      assert.equal(reply.querySelector(".pk-sources"), null);
    },
  );
  await t.test(
    "local chat saves escaped messages and closes cleanly",
    async () => {
      volunteer.document.querySelector('[data-action="open-chat"]').click();
      await volunteer.waitFor(".dm-chat-dialog .dm-message-form");
      const text = '<svg onload="alert(1)">Нужна помощь</svg>';
      fill(volunteer, "body", text);
      submit(volunteer, ".dm-message-form");
      await volunteer.waitFor(() =>
        volunteer.document
          .querySelector(".dm-live")
          ?.textContent.includes("Сообщение отправлено"),
      );
      assert.equal(
        volunteer.document.querySelector(".dm-bubble p").textContent,
        text,
      );
      assert.equal(volunteer.document.querySelector(".dm-bubble svg"), null);
      assert.equal((await volunteer.api("/chat")).items.at(-1).body, text);
      volunteer.document.querySelector("[data-dm-close]").click();
      await volunteer.waitFor(
        () => !volunteer.document.querySelector(".dm-chat-dialog"),
      );
      assert.equal(volunteer.document.body.style.overflow, "");
    },
  );
  await t.test(
    "role preview redirects and admin export requires password",
    async () => {
      const admin = await login("admin@demo.local");
      await navigate(admin, "role-preview", "#org-users-filter");
      await admin.waitFor(() => admin.window.location.hash === "#users");
      assert.equal(
        admin.document.querySelector('a[href="#role-preview"]'),
        null,
      );
      await navigate(admin, "audit", '[data-action="export-data"]');
      admin.document.querySelector('[data-action="export-data"]').click();
      await admin.waitFor('[name="export_password"]');
      assert.equal(
        admin.document.querySelector('[name="export_password"]').type,
        "password",
      );
    },
  );
  await t.test("no unhandled runtime errors in tested DOM interactions", () => {
    for (const ui of windows)
      assert.deepEqual(
        ui.errors.map((error) => error.message),
        [],
      );
  });
});

test("integration client keeps CSRF, structured errors and download links constrained", async () => {
  const { readFile } = require("node:fs/promises");
  const source = await readFile(
    require.resolve("../integration/api-client.js"),
    "utf8",
  );
  const { createApiClient, ApiError } = await import(
    `data:text/javascript;base64,${Buffer.from(source + "\n//# sourceURL=integration/api-client.js\n").toString("base64")}`
  );
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/csrf")
        return Response.json({ csrfToken: "local-test-token" });
      assert.equal(options.credentials, "include");
      assert.equal(options.headers.get("X-CSRF-Token"), "local-test-token");
      if (url === "/api/auth/login-code/request")
        return Response.json(
          { error: "Аккаунт не найден", code: "account_not_found" },
          { status: 404 },
        );
      if (url === "/api/admin/exports/prepare")
        return Response.json({
          download_url: "https://untrusted.example.test/file",
        });
      throw new Error("Unexpected mock API request");
    },
  });
  await assert.rejects(
    client.auth.requestLoginCode("missing@example.test"),
    (error) =>
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === "account_not_found",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/auth/csrf")).length,
    1,
  );
  await assert.rejects(
    client.admin.prepareExport("csv", "local-test-password"),
    (error) => error.code === "INVALID_DOWNLOAD_URL",
  );
  await assert.rejects(client.get("//untrusted.example.test"), TypeError);
  assert.throws(() => client.users.get("../admin"), TypeError);
});
