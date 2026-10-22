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
  const stopDelivery = require("../src/login-code").startLoginCodeDelivery({
    db: database,
    mailer,
    intervalMs: 50,
  });
  const server = createApp({ mailer }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const windows = [];
  t.after(async () => {
    windows.forEach((ui) => ui.close());
    await stopDelivery();
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
      fill(volunteer, "city", "Самара");
      submit(volunteer, "#profile-form");
      await until(
        async () => (await volunteer.api("/me")).user.phone === "+79001234567",
      );
      assert.equal((await volunteer.api("/me")).user.city, "Самара");
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
  await t.test(
    "event groups keep announcements, member direct messages and support separate",
    async () => {
      await navigate(volunteer, `event-chat/${event.id}`, ".community-compose");
      const group = (await volunteer.api(`/groups/events/${event.id}`)).item;
      const text = '<img onerror="alert(1)">Помогу на встрече';
      fill(volunteer, "body", text);
      submit(volunteer, ".community-compose");
      await volunteer.waitFor(() =>
        volunteer.document
          .querySelector(".dm-live")
          ?.textContent.includes("отправлено"),
      );
      assert.equal(volunteer.document.querySelector(".dm-bubble img"), null);
      assert.equal(
        (await volunteer.api(`/groups/${group.id}/messages`)).items.at(-1).body,
        text,
      );
      assert.equal(
        volunteer.document.querySelector("[data-community-kind]").hidden,
        true,
      );
      await navigate(manager, `event-chat/${event.id}`, ".community-compose");
      fill(manager, "kind", "announcement");
      fill(manager, "body", "Встречаемся у входа в мастерскую");
      submit(manager, ".community-compose");
      await manager.waitFor(".community-announcement");
      await navigate(
        volunteer,
        `groups/${group.id}`,
        ".community-announcement",
      );
      const details = volunteer.document.querySelector(".community-members");
      details.open = true;
      details.dispatchEvent(new volunteer.window.Event("toggle"));
      const managerId = (await manager.api("/me")).user.id;
      const directButton = await volunteer.waitFor(
        `[data-community-direct="${managerId}"]`,
      );
      directButton.click();
      await volunteer.waitFor(
        () =>
          volunteer.window.location.hash.startsWith("#groups/") &&
          volunteer.window.location.hash !== `#groups/${group.id}`,
      );
      await volunteer.waitFor(".community-compose");
      assert.equal(
        volunteer.document.querySelector(".community-members"),
        null,
      );
      fill(volunteer, "body", "Личное уточнение времени");
      submit(volunteer, ".community-compose");
      await volunteer.waitFor(() =>
        volunteer.document
          .querySelector(".dm-live")
          ?.textContent.includes("отправлено"),
      );
      const directId = volunteer.window.location.hash.split("/")[1];
      await navigate(manager, `groups/${directId}`, ".community-compose");
      assert.match(
        manager.document.querySelector(".dm-message-list").textContent,
        /Личное уточнение/,
      );
      assert.equal(
        (await manager.api(`/groups/${group.id}/messages`)).items.some((item) =>
          item.body.includes("Личное уточнение"),
        ),
        false,
      );
      await navigate(
        manager,
        `organizer-events/${event.id}`,
        `[data-action="org-archive-event"][data-id="${event.id}"]`,
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
      await navigate(volunteer, "groups", "[data-community-support]");
      volunteer.document.querySelector("[data-community-support]").click();
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
  await t.test(
    "manager previews and applies CSV imports without creating consent",
    async () => {
      await navigate(manager, "users", 'a[href="#questionnaire-import"]');
      manager.document.querySelector('a[href="#questionnaire-import"]').click();
      await manager.waitFor("#questionnaire-import-form");
      fill(
        manager,
        "csv",
        "full_name,email,city\nНовый <b>волонтёр</b>,ui-import@example.test,Тверь\nДубликат,volunteer@demo.local,Москва",
      );
      submit(manager, "#questionnaire-import-form");
      await manager.waitFor("[data-import-preview] tbody tr");
      assert.equal(
        manager.document.querySelector("[data-import-preview] b"),
        null,
      );
      assert.match(
        manager.document.querySelector("[data-import-preview]").textContent,
        /Пропущен/,
      );
      const before = await manager.api("/users?q=ui-import@example.test");
      assert.equal(before.total, 0);
      fill(
        manager,
        "csv",
        "full_name,email,city\nНовый <b>волонтёр</b>,ui-import@example.test,Тверь",
      );
      assert.equal(
        manager.document.querySelector("#questionnaire-import-apply"),
        null,
      );
      submit(manager, "#questionnaire-import-form");
      await manager.waitFor("#questionnaire-import-apply");
      fill(manager, "confirm", true);
      submit(manager, "#questionnaire-import-apply");
      await manager.waitFor(() =>
        manager.document
          .querySelector("[data-import-preview]")
          .textContent.includes("Импорт завершён"),
      );
      const imported = (await manager.api("/users?q=ui-import@example.test"))
        .items[0];
      assert.equal(imported.city, "Тверь");
      assert.equal(imported.role, "volunteer");
      const stored = await database.query(
        "SELECT email_verified_at FROM users WHERE id=$1",
        [imported.id],
      );
      assert.equal(stored.rows[0].email_verified_at, null);
      const importedUI = await open({ route: "#login" });
      await importedUI.waitFor("#auth-form");
      fill(importedUI, "email", "ui-import@example.test");
      submit(importedUI, "#auth-form");
      await importedUI.waitFor("#login-verification-form");
      const code = (
        await until(() =>
          sent.findLast(
            (entry) =>
              entry.kind === "login" &&
              entry.email === "ui-import@example.test",
          ),
        )
      ).code;
      assert.notEqual(code, "1234");
      otp(importedUI, code);
      submit(importedUI, "#login-verification-form");
      await importedUI.waitFor(".sidebar");
      await navigate(importedUI, "profile", "#profile-form");
      assert.match(
        importedUI.document.querySelector(".profile-security").textContent,
        /Пароль ещё не установлен/,
      );
      assert.ok(
        importedUI.document.querySelector(
          '.profile-security a[href="#forgot-password"]',
        ),
      );
      assert.equal(
        importedUI.document.querySelector('[data-action="change-password"]'),
        null,
      );
      await navigate(coordinator, "questionnaire-import", "#content .empty");
      assert.equal(
        coordinator.document.querySelector("#questionnaire-import-form"),
        null,
      );
    },
  );
  await t.test(
    "no mandatory training permits next step and course gating has an explicit CTA",
    async () => {
      const ui = await login("volunteer@demo.local", {
        fetchAdapter: async (url, options, send) => {
          const response = await send();
          if (!response.ok || (options.method && options.method !== "GET"))
            return response;
          const path = new URL(url).pathname;
          if (
            ![
              "/api/courses/summary",
              "/api/questionnaire",
              "/api/opportunities/1",
            ].includes(path)
          )
            return response;
          const data = await response.json();
          if (path === "/api/courses/summary") {
            data.summary.required_total = 0;
            data.summary.required_completed = 0;
          }
          if (path === "/api/questionnaire")
            data.completed_at = new Date().toISOString();
          if (path === "/api/opportunities/1") {
            data.item.my_application = null;
            data.item.status = "open";
            data.item.training_requirement = {
              course_id: 987,
              available: true,
              completed: false,
            };
            data.item.required_course_title = "Вводный курс";
          }
          return Response.json(data, { status: response.status });
        },
      });
      await navigate(
        ui,
        "dashboard",
        '.dashboard-next a[href="#opportunities"]',
      );
      assert.match(
        ui.document.querySelector(".dashboard-stats").textContent,
        /Обязательное обучение пока не назначено/,
      );
      await navigate(ui, "profile", "#profile-form");
      assert.match(
        ui.document.querySelector(".profile-milestones").textContent,
        /Обязательное обучение пока не назначено/,
      );
      await navigate(
        ui,
        "participation",
        'nav[aria-label="Мой вклад"] a[href="#applications"]',
      );
      ui.document
        .querySelector('nav[aria-label="Мой вклад"] a[href="#applications"]')
        .click();
      await ui.waitFor("#applications-filter");
      assert.ok(
        ui.document.querySelector(
          '.sidebar a[href="#participation"][aria-current="page"]',
        ),
      );
      await navigate(
        ui,
        "opportunities/1",
        '.event-apply a[href="#training/course/987"]',
      );
      assert.equal(ui.document.querySelector('[data-action="apply"]'), null);
    },
  );
  await t.test(
    "own group sends do not skip concurrent incoming messages or mark gaps read",
    async () => {
      let sentMessage = false;
      const readIds = [],
        cursors = [];
      const group = {
        id: 777,
        kind: "event",
        title: "Проверка порядка",
        read_only: false,
        can_announce: false,
      };
      const message = (id, body, mine = false) => ({
        id,
        body,
        is_mine: mine,
        sender_name: "Участник",
        kind: "message",
        created_at: new Date().toISOString(),
      });
      const ui = await login("volunteer@demo.local", {
        fetchAdapter: async (url, options, send) => {
          const target = new URL(url);
          if (target.pathname === "/api/groups/777/read") {
            readIds.push(JSON.parse(options.body).message_id);
            return Response.json({ ok: true });
          }
          if (target.pathname !== "/api/groups/777/messages") return send();
          if (options.method === "POST") {
            sentMessage = true;
            return Response.json({
              message: message(102, "Моё сообщение", true),
            });
          }
          const cursor = Number(target.searchParams.get("after_id"));
          cursors.push(cursor);
          return Response.json({
            group,
            items:
              cursor === 100 && sentMessage
                ? [
                    message(101, "Одновременный ответ"),
                    message(102, "Моё сообщение", true),
                  ]
                : cursor
                  ? []
                  : [message(100, "Начало")],
            has_more: false,
          });
        },
      });
      await navigate(ui, "groups/777", ".community-compose");
      await ui.waitFor(() => readIds.includes(100));
      fill(ui, "body", "Моё сообщение");
      submit(ui, ".community-compose");
      await ui.waitFor(() =>
        ui.document
          .querySelector(".dm-message-list")
          .textContent.includes("Одновременный ответ"),
      );
      const bodies = [...ui.document.querySelectorAll(".dm-bubble p")].map(
        (el) => el.textContent,
      );
      assert.deepEqual(bodies, [
        "Начало",
        "Одновременный ответ",
        "Моё сообщение",
      ]);
      assert.ok(cursors.includes(100));
      await ui.waitFor(() => readIds.includes(102));
      assert.equal(readIds[0], 100);
    },
  );
  await t.test(
    "closed event conversations remain readable but disable sending",
    async () => {
      await navigate(volunteer, `event-chat/${event.id}`, ".community-compose");
      assert.equal(
        volunteer.document.querySelector('[name="body"]').disabled,
        true,
      );
      assert.equal(
        volunteer.document.querySelector('.community-compose [type="submit"]')
          .disabled,
        true,
      );
      assert.match(
        volunteer.document.querySelector(".dm-message-list").textContent,
        /Помогу на встрече/,
      );
    },
  );
  await t.test(
    "support chat also preserves concurrent incoming replies",
    async () => {
      let sentMessage = false;
      const cursors = [];
      const message = (id, body, sender_kind = "user") => ({
        id,
        body,
        sender_kind,
        sender_name: "Команда",
        created_at: new Date().toISOString(),
      });
      const thread = { id: 777, owner_read_id: 0, staff_read_id: 0 };
      const ui = await login("volunteer@demo.local", {
        fetchAdapter: async (url, options, send) => {
          const target = new URL(url);
          if (target.pathname === "/api/chat/read")
            return Response.json({ ok: true });
          if (
            target.pathname === "/api/chat/messages" &&
            options.method === "POST"
          ) {
            sentMessage = true;
            return Response.json({ message: message(102, "Мой вопрос") });
          }
          if (target.pathname !== "/api/chat") return send();
          const cursor = Number(target.searchParams.get("after_id"));
          cursors.push(cursor);
          return Response.json({
            thread,
            items:
              cursor === 100 && sentMessage
                ? [
                    message(101, "Ответ организатора", "organizer"),
                    message(102, "Мой вопрос"),
                  ]
                : cursor
                  ? []
                  : [message(100, "Начало")],
            has_more: false,
          });
        },
      });
      await navigate(ui, "groups", "[data-community-support]");
      ui.document.querySelector("[data-community-support]").click();
      await ui.waitFor(".dm-chat-dialog .dm-message-form");
      fill(ui, "body", "Мой вопрос");
      submit(ui, ".dm-chat-dialog .dm-message-form");
      await ui.waitFor(() =>
        ui.document
          .querySelector(".dm-message-list")
          .textContent.includes("Ответ организатора"),
      );
      assert.deepEqual(
        [...ui.document.querySelectorAll(".dm-bubble p")].map(
          (el) => el.textContent,
        ),
        ["Начало", "Ответ организатора", "Мой вопрос"],
      );
      assert.ok(cursors.includes(100));
      ui.document.querySelector("[data-dm-close]").click();
      await ui.waitFor(() => !ui.document.querySelector(".dm-chat-dialog"));
    },
  );
  await t.test(
    "only administrators grant achievements and confirmed revocations update volunteer views",
    async () => {
      const admin = await login("admin@demo.local");
      const volunteerId = (await volunteer.api("/me")).user.id;
      const catalog = (await admin.api("/achievements")).items;
      assert.equal(catalog.length, 5);
      await navigate(volunteer, "participation", ".achievement-catalog");
      assert.equal(
        volunteer.document.querySelectorAll(".achievement-catalog .is-locked")
          .length,
        5,
      );
      assert.match(
        volunteer.document.querySelector("[data-achievements]").textContent,
        /вручает администратор/,
      );
      assert.equal(
        volunteer.document.querySelector(".achievement-grant-form"),
        null,
      );
      for (const staffUI of [manager, coordinator]) {
        await navigate(staffUI, `users/${volunteerId}`, ".achievement-empty");
        assert.equal(
          staffUI.document.querySelector(".achievement-grant-form"),
          null,
        );
        assert.equal(
          staffUI.document.querySelector("[data-revoke-achievement]"),
          null,
        );
      }
      await navigate(admin, `users/${volunteerId}`, ".achievement-grant-form");
      fill(admin, "achievement_id", catalog[0].id);
      submit(admin, ".achievement-grant-form");
      await admin.waitFor("[data-revoke-achievement]");
      assert.equal((await volunteer.api("/me/achievements")).total, 1);
      assert.equal(
        admin.document.querySelector(
          `.achievement-grant-form option[value="${catalog[0].id}"]`,
        ),
        null,
      );
      await navigate(volunteer, "profile", "[data-achievements] .is-earned");
      assert.match(
        volunteer.document.querySelector("[data-achievements]").textContent,
        /Первое доброе дело/,
      );
      await navigate(
        volunteer,
        "participation",
        ".achievement-catalog .is-earned",
      );
      assert.equal(
        volunteer.document.querySelectorAll(".achievement-catalog .is-earned")
          .length,
        1,
      );
      assert.equal(
        volunteer.document.querySelectorAll(".achievement-catalog .is-locked")
          .length,
        4,
      );
      assert.deepEqual(
        [
          ...volunteer.document.querySelectorAll(
            ".achievement-catalog .achievement-rarity",
          ),
        ].map((item) => item.textContent),
        ["Обычное", "Необычное", "Редкое", "Эпическое", "Легендарное"],
      );
      assert.equal(
        volunteer.document.querySelectorAll("[data-achievements] svg").length,
        6,
      );
      assert.equal(
        volunteer.document.querySelector("[data-achievements] img"),
        null,
      );
      admin.document.querySelector("[data-revoke-achievement]").click();
      await admin.waitFor("[data-confirm-revoke]");
      assert.equal((await volunteer.api("/me/achievements")).total, 1);
      admin.document.querySelector("[data-cancel-revoke]").click();
      assert.equal(admin.document.querySelector("[data-confirm-revoke]"), null);
      assert.equal((await volunteer.api("/me/achievements")).total, 1);
      admin.document.querySelector("[data-revoke-achievement]").click();
      admin.document.querySelector("[data-confirm-revoke]").click();
      await admin.waitFor(".achievement-empty");
      assert.equal((await volunteer.api("/me/achievements")).total, 0);
      await navigate(
        volunteer,
        "profile",
        "[data-achievements] .achievement-empty",
      );
    },
  );
  await t.test(
    "achievement labels are escaped and an unavailable award service leaves the profile usable",
    async () => {
      let unavailable = true;
      const ui = await login("volunteer@demo.local", {
        fetchAdapter: async (target, options, send) => {
          const path = new URL(target).pathname;
          if (path === "/api/me/achievements" && unavailable)
            return Response.json(
              { error: "Не удалось загрузить <script>награды</script>" },
              { status: 503 },
            );
          if (path === "/api/achievements") {
            const response = await send();
            const data = await response.json();
            data.items[0].title = '<img src=x onerror="alert(1)">';
            data.items[0].description = "<script>untrusted</script>";
            data.items[0].icon = '<svg onload="alert(1)">';
            data.items[0].rarity = 'rare" onclick="alert(1)';
            return Response.json(data);
          }
          return send();
        },
      });
      await navigate(ui, "profile", "[data-achievements] .form-error");
      assert.ok(ui.document.querySelector("#profile-form"));
      assert.equal(
        ui.document.querySelector("[data-achievements] script"),
        null,
      );
      assert.match(
        ui.document.querySelector("[data-achievements] .form-error")
          .textContent,
        /<script>/,
      );
      unavailable = false;
      ui.document.querySelector("[data-achievements] button").click();
      await ui.waitFor("[data-achievements] .achievement-empty");
      await navigate(ui, "participation", ".achievement-catalog");
      const collection = ui.document.querySelector(".achievement-catalog");
      assert.match(collection.textContent, /<img src=x/);
      assert.equal(
        collection.querySelector("img,script,[onclick],[onload]"),
        null,
      );
      assert.ok(collection.querySelector(".achievement-common svg path"));
    },
  );
  await t.test("late badge counts do not touch a closed page", async () => {
    let hold = false;
    const pending = [];
    const ui = await login("volunteer@demo.local", {
      fetchAdapter: async (target, options, send) => {
        if (hold && new URL(target).pathname.endsWith("/unread-count")) {
          return new Promise((resolve) =>
            pending.push(() => resolve(Response.json({ unread: 0 }))),
          );
        }
        return send();
      },
    });
    await ui.window.refreshBadge();
    hold = true;
    const refresh = ui.window.refreshBadge();
    await until(() => pending.length === 2);
    ui.close();
    pending.forEach((resolve) => resolve());
    await refresh;
  });
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
