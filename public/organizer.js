"use strict";

// Loaded before app.js; shared helpers are resolved only when a screen is opened.
window.PortalOrganizer = (() => {
  const ui = {
    views: {},
    users: new Map(),
    tasks: new Map(),
    events: new Map(),
    editor: null,
    selectedEvent: null,
    selectedTask: null,
    published: null,
    scroll: new Map(),
    restore: null,
  };
  const asset = (name) => `/assets/figma/organizer/${name}`;
  const imageIcon = (name) =>
    `<img class="org-icon" src="${asset(name)}" alt="">`;
  const n = (value) => Number(value || 0).toLocaleString("ru-RU");
  const participationPlural = new Intl.PluralRules("ru-RU");
  const participationCount = (value) =>
    `${n(value)} ${{ one: "участие", few: "участия", many: "участий" }[participationPlural.select(Number(value || 0))] || "участия"}`;
  const items = (value) => (Array.isArray(value) ? value : value?.items || []);
  const view = (key) => (ui.views[key] ||= { page: 1 });
  const qs = (data) =>
    new URLSearchParams(
      Object.entries(data).filter(([, v]) => v !== "" && v != null),
    ).toString();
  const action = (label, name, attributes = "", secondary = false) =>
    button(label, `org-${name}`, attributes, secondary);
  const link = (label, route, className = "text-link") =>
    `<a class="${className}" href="#${h(route)}">${h(label)}</a>`;
  const statuses = {
    new: "Новый профиль",
    active: "Участвует",
    paused: "Пауза",
    closed: "Закрыт",
    draft: "Черновик",
    open: "Набор открыт",
    pending: "Новая",
    accepted: "Подтверждено",
    rejected: "Не подходит сейчас",
    withdrawn: "Отозвана",
    in_progress: "В работе",
    done: "Готово",
    cancelled: "Отменена",
  };
  const taskStatuses = [
    ["open", "Новая"],
    ["in_progress", "В работе"],
    ["done", "Готово"],
    ["cancelled", "Отменена"],
  ];
  const userStatuses = [
    ["new", "Новый профиль"],
    ["active", "Участвует"],
    ["paused", "Пауза"],
    ["closed", "Закрыт"],
  ];
  const badge = (status, task = false) => {
    const tone =
      ["active", "accepted", "done"].includes(status) ||
      (status === "open" && !task)
        ? "green"
        : ["new", "pending"].includes(status) || (task && status === "open")
          ? "coral"
          : "muted";
    return `<span class="org-status org-status-${tone}">${imageIcon(tone === "green" ? "89c37.svg" : tone === "coral" ? "bc005.svg" : "5d1aa.svg")}${h(task && status === "open" ? "Новая" : statuses[status] || status)}</span>`;
  };
  const heading = (title, description, controls = "") =>
    `<div class="org-heading"><div><h1>${h(title)}</h1><p>${h(description)}</p></div>${controls ? `<div class="actions">${controls}</div>` : ""}</div>`;
  const metric = (value, label, caption = "") =>
    `<article class="org-metric"><strong>${h(value)}</strong><span>${h(label)}</span>${caption ? `<small>${h(caption)}</small>` : ""}</article>`;
  const note = (text) => `<p class="org-help">${h(text)}</p>`;
  const section = (title, body, extra = "") =>
    `<section class="org-card ${extra}"><h2>${h(title)}</h2>${body}</section>`;
  const emptyState = (title, body) =>
    `<div class="org-empty"><h3>${h(title)}</h3><p>${h(body)}</p></div>`;
  const table = (labels, rows) =>
    `<div class="table-wrap org-table-wrap" tabindex="0" role="region" aria-label="Таблица данных"><table class="org-table" role="table"><thead role="rowgroup"><tr role="row">${labels.map((x) => `<th scope="col" role="columnheader">${h(x)}</th>`).join("")}</tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>`;
  const detail = (label, value) =>
    `<div><dt>${h(label)}</dt><dd>${value || "Не указано"}</dd></div>`;
  const dates = (item) =>
    item.starts_at ? date(item.starts_at, true) : "Дата пока не указана";
  const eventPreparation = (item) =>
    `${item.preparation ? `<h3>Подготовка к встрече</h3><p class="preserve">${h(item.preparation)}</p>` : ""}${item.required_course_id ? `<h3>Обучение перед встречей</h3><p>${link(item.required_course_title || `Курс №${item.required_course_id}`, `training/course/${item.required_course_id}`)}</p>${note("Прохождение курса не подтверждает участие автоматически. Ответ по заявке даст координатор.")}` : ""}`;
  const eventCoordination = (item) =>
    `${detail("Координатор", h(item.coordinator_name || "Пока не назначен"))}${detail("Приём заявок до", item.application_deadline ? date(item.application_deadline, true) : "До закрытия набора")}`;
  const eventBadge = (item) =>
    item.archived_at
      ? `<span class="org-status org-status-muted">${imageIcon("5d1aa.svg")}В корзине</span>`
      : item.status === "closed"
        ? `<span class="org-status">${imageIcon("5d1aa.svg")}Набор закрыт</span>`
        : badge(item.status);
  const deny = (set) =>
    set(
      `<div class="org-page">${emptyState("Раздел недоступен", "У вашего аккаунта нет доступа к этому разделу.")}</div>`,
    );

  async function getPage(path, key, filters = {}) {
    const stateView = view(key),
      task = path === "/staff-tasks";
    const load = () =>
      api(
        `${path}?${qs({ ...filters, page: stateView.page, ...(task ? {} : { page_size: 50 }) })}`,
      );
    let data = await load();
    if (stateView.page > Math.max(1, Number(data.pages || 1))) {
      stateView.page = Math.max(1, Number(data.pages || 1));
      data = await load();
    }
    return data;
  }
  function pager(data, key) {
    const current = Number(data?.page || 1),
      pages = Math.max(1, Number(data?.pages || 1));
    return `<div class="org-pagination"><span>Найдено: ${n(data?.total)} · ${current} / ${pages}</span><div class="actions">${action("← Назад", "page", `data-key="${h(key)}" data-page="${current - 1}" ${current <= 1 ? "disabled" : ""}`, true)}${action("Далее →", "page", `data-key="${h(key)}" data-page="${current + 1}" ${current >= pages ? "disabled" : ""}`, true)}</div></div>`;
  }
  function show(set, html) {
    if (!set(`<div class="org-page">${html}</div>`)) return false;
    // The same records stay a table for assistive technology and become
    // labelled rows on phones; no separate data request or hidden columns.
    document.querySelectorAll(".org-table").forEach((tableElement) => {
      const labels = [...tableElement.querySelectorAll("thead th")].map(
        (cell) => cell.textContent.trim(),
      );
      tableElement.querySelectorAll("tbody tr").forEach((row) => {
        row.setAttribute("role", "row");
        [...row.cells].forEach((cell, index) => {
          cell.setAttribute("role", "cell");
          const label = document.createElement("span");
          label.className = "org-cell-label";
          label.setAttribute("aria-hidden", "true");
          label.textContent = labels[index] || "Действия";
          cell.prepend(label);
        });
      });
    });
    if (ui.restore === location.hash) {
      const position = ui.scroll.get(location.hash) || 0;
      ui.restore = null;
      requestAnimationFrame(() => {
        if (set.current())
          window.scrollTo({ top: position, behavior: "instant" });
      });
    }
    return true;
  }
  function remember() {
    ui.scroll.set(location.hash, window.scrollY);
  }
  async function refresh(keepScroll = true) {
    const hash = location.hash,
      y = window.scrollY;
    await renderRoute();
    if (keepScroll && hash === location.hash)
      window.scrollTo({ top: y, behavior: "instant" });
  }
  function filterForm(selector, key, fields) {
    bindForm(document.querySelector(selector), async (data) => {
      for (const fieldName of fields)
        view(key)[fieldName] = String(data.get(fieldName) || "").trim();
      view(key).page = 1;
      await refresh(false);
    });
  }
  function wireRemember() {
    document
      .querySelectorAll(
        '.org-page a[href^="#users/"], .org-page a[href^="#organizer-events/"]',
      )
      .forEach((a) => a.addEventListener("click", remember));
  }

  const eventFilterKeys = [
    "q",
    "status",
    "city",
    "format",
    "interest",
    "skill",
    "date_from",
    "date_to",
    "available",
    "sort",
  ];
  function eventFilterForm(values, choices, total) {
    const choice = (label, name, allLabel) => {
      const options = [
        ...(choices[
          {
            city: "cities",
            format: "formats",
            skill: "skills",
            interest: "interests",
          }[name]
        ] || []),
      ];
      if (values[name] && !options.includes(values[name]))
        options.push(values[name]);
      return select(
        label,
        name,
        [["", allLabel], ...options.map((value) => [value, value])],
        values[name] || "",
      );
    };
    const active = eventFilterKeys.filter(
      (key) => values[key] && !(key === "sort" && values[key] === "soonest"),
    ).length;
    const advanced = [
      "interest",
      "skill",
      "date_from",
      "date_to",
      "status",
      "available",
    ].some((key) => values[key]);
    const markup = `<div class="org-filter-primary">${field("Поиск", "q", values.q || "", "search", false, 'maxlength="120" placeholder="Название, тема или описание"')}${choice("Город", "city", "Все города")}${choice("Формат участия", "format", "Все форматы")}</div><details class="org-filter-details" ${advanced ? "open" : ""}><summary>Дополнительные фильтры${active ? ` · ${active} выбрано` : ""}</summary><div class="org-filter-grid">${choice("Интерес", "interest", "Все интересы")}${choice("Навык", "skill", "Все навыки")}${select(
      "Статус",
      "status",
      [
        ["", "Все статусы"],
        ["draft", "Черновики"],
        ["open", "Набор открыт"],
        ["closed", "Набор закрыт"],
      ],
      values.status || "",
    )}${field("Начало: с даты", "date_from", values.date_from || "", "date")}${field("Начало: по дату", "date_to", values.date_to || "", "date")}${select(
      "Наличие мест",
      "available",
      [
        ["", "Все мероприятия"],
        ["true", "Есть места и приём заявок открыт"],
      ],
      values.available || "",
    )}</div></details><div class="org-filter-footer">${select(
      "Сортировка",
      "sort",
      [
        ["soonest", "Ближайшие сначала"],
        ["latest", "Поздние даты сначала"],
        ["newest", "Недавно добавленные"],
      ],
      values.sort || "soonest",
    )}<div class="actions"><button type="submit" class="button">Применить</button>${action("Сбросить", "reset", 'data-key="events"', true)}</div></div><p class="org-filter-count" role="status">Найдено мероприятий: ${n(total)}${active ? ` · Фильтров: ${active}` : ""}</p><div class="form-error" role="alert"></div>`;
    // Separate IDs from the participant filters on the same screen.
    return `<form id="org-events-filter" class="org-filters org-event-filters">${markup.replace(/\b(for|id)="([a-z_]+)"/g, '$1="org-event-filter-$2"')}</form>`;
  }

  function volunteerCard(user) {
    const interests = [
      ...new Set([...items(user.interests), ...items(user.skills)]),
    ].slice(0, 4);
    return `<article class="org-volunteer-card" aria-labelledby="volunteer-card-${user.id}"><div class="org-volunteer-card-heading"><span class="avatar" aria-hidden="true">${h(initials(String(user.full_name || "").replace(/^Демо\s*·\s*/u, "")))}</span><div><h3 id="volunteer-card-${user.id}">${link(user.full_name, `users/${user.id}`, "org-person")}</h3><p>${h(user.city || "Город пока не указан")}</p></div></div>${badge(user.status)}<dl class="org-card-facts"><div><dt>Формат участия</dt><dd>${h(user.participation_format || "Уточним при знакомстве")}</dd></div><div><dt>Регулярность</dt><dd>${h(user.participation_frequency || "Пока не указана")}</dd></div></dl><div class="tags">${interests.length ? interests.map((value) => `<span class="pill">${h(value)}</span>`).join("") : '<span class="org-help">Интересы и навыки пока не заполнены</span>'}</div><div class="org-volunteer-card-footer"><p><strong>${n(user.total_hours)} ч</strong><span>${participationCount(user.participation_count)}</span></p>${link("Открыть профиль →", `users/${user.id}`)}</div></article>`;
  }
  async function renderUsers(set) {
    const v = view("users");
    if (!v.layout)
      v.layout = window.matchMedia("(max-width: 767px)").matches
        ? "cards"
        : "table";
    const [data, total, fresh, hours, tasks, applications] = await Promise.all([
      getPage("/users", "users", {
        q: v.q,
        status: v.status,
        skill: v.skill,
        city: v.city,
        role: "volunteer",
      }),
      api("/users?role=volunteer&page_size=1"),
      api("/users?role=volunteer&status=new&page_size=1"),
      api("/participation?page_size=1"),
      api("/staff-tasks?mine=true&overdue=true"),
      api("/applications?status=pending&page_size=1"),
    ]);
    if (!set.current()) return;
    ui.users = new Map(items(data).map((x) => [String(x.id), x]));
    const rows = items(data)
      .map(
        (user) =>
          `<tr><td><a class="org-person" href="#users/${user.id}">${h(user.full_name)}</a><small>${h(user.email)}</small></td><td>${badge(user.status)}</td><td>${h([...items(user.interests), ...items(user.skills)].slice(0, 4).join(", ") || "Не указаны")}<small>${h([user.participation_format, user.city].filter(Boolean).join(" · "))}</small></td><td>${h(user.participation_frequency || "В профиле")}</td><td>${user.total_hours != null ? `${n(user.total_hours)} ч<small>${participationCount(user.participation_count)}</small>` : link("История →", `users/${user.id}`)}</td><td>${link("Открыть профиль →", `users/${user.id}`)}</td></tr>`,
      )
      .join("");
    if (
      !show(
        set,
        `${heading("Волонтёры", "Профили, интересы и история участия — в одной базе.", manager() ? `<div class="actions">${action("Добавить волонтёра", "add-user")}${link("Импорт анкет", "questionnaire-import", "button secondary")}</div>` : "")}<div class="org-metrics">${metric(n(total.total), "Профилей в базе", "Включая закрытые профили")}${metric(n(fresh.total), "Новых профилей", "Ждут первого знакомства")}${metric(`${n(hours.summary?.total_hours)} ч`, "Времени вместе", "Подтверждено координаторами")}</div><form id="org-users-filter" class="org-filters">${field("Поиск по базе", "q", v.q || "", "search", false, 'placeholder="Имя или почта" maxlength="120"')}${select("Статус", "status", [["", "Все статусы"], ...userStatuses], v.status || "")}${field("Навык", "skill", v.skill || "", "text", false, 'maxlength="80" placeholder="Любой"')}${field("Город", "city", v.city || "", "text", false, 'maxlength="120" placeholder="Любой"')}<button class="button secondary" type="submit">Найти</button>${action("Сбросить", "reset", 'data-key="users"', true)}</form><section class="org-card org-card-table"><div class="org-section-title"><div><h2>Все волонтёры</h2><span class="muted small">${n(data.total)} профилей</span></div><div class="org-view-toggle" role="group" aria-label="Вид списка волонтёров">${action("Таблица", "users-layout", `data-layout="table" aria-pressed="${v.layout !== "cards"}"`, true)}${action("Карточки", "users-layout", `data-layout="cards" aria-pressed="${v.layout === "cards"}"`, true)}</div></div>${rows ? (v.layout === "cards" ? `<div class="org-volunteer-grid">${items(data).map(volunteerCard).join("")}</div>` : table(["Волонтёр", "Статус", "Интересы", "Регулярность", "Участие", "Следующий шаг"], rows)) : emptyState("Никого не нашли по этим условиям", "Сбросьте фильтры или измените запрос.")}${pager(data, "users")}</section><div class="org-two-cards">${section("Задачи, которым нужно внимание", `<p>${tasks.total ? `Ваших просроченных задач: ${n(tasks.total)}.` : "Просроченных задач, назначенных вам, нет."}</p>${link("Перейти к задачам →", "staff-tasks")}`)}${section("Новые заявки на встречи", `<p>${applications.total ? `${n(applications.total)} заявок ожидают ответа команды.` : "Все заявки рассмотрены. Новые отклики появятся здесь."}</p>${link("Разобрать заявки →", "applications")}`)}</div>`,
      )
    )
      return;
    filterForm("#org-users-filter", "users", ["q", "status", "skill", "city"]);
    wireRemember();
  }

  async function renderUser(set, id) {
    const key = (name) => `user:${id}:${name}`;
    const query = {
      page_size: 50,
      ...Object.fromEntries(
        ["participation", "applications", "training", "notes"].map((name) => [
          `${name}_page`,
          view(key(name)).page,
        ]),
      ),
    };
    const [data, tasks] = await Promise.all([
      api(`/users/${encodeURIComponent(id)}?${qs(query)}`),
      api(`/staff-tasks?user_id=${encodeURIComponent(id)}`),
    ]);
    if (!set.current()) return;
    const user = data.user;
    ui.users.set(String(id), user);
    const summary = data.summary || {},
      training = items(data.training),
      history = items(data.participation);
    history.forEach((record) =>
      state.participation.set(String(record.id), record),
    );
    const nextTask = items(tasks).find((x) =>
      ["open", "in_progress"].includes(x.status),
    );
    const nextApplication = items(data.applications)
      .filter(
        (x) =>
          x.status === "accepted" &&
          x.starts_at &&
          Date.parse(x.starts_at) > Date.now(),
      )
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
    const profile = section(
      "Профиль",
      `<div class="org-inline-actions">${action("Изменить статус", "user-status", `data-id="${id}"`, true)}${admin() ? action("Права доступа", "user-role", `data-id="${id}"`, true) : ""}</div><dl class="org-details">${detail("Электронная почта", h(user.email))}${detail("Город и формат", h([user.city, user.participation_format].filter(Boolean).join(" · ")))}${detail("Телефон", h(user.phone || "Не указан"))}${detail("Регулярность", h(user.participation_frequency || "Не указана"))}${manager() ? detail("Дата рождения", date(user.birth_date)) : ""}</dl><div class="org-divider"></div><dl class="org-details org-details-single">${detail("Интересы и навыки", h([...items(user.interests), ...items(user.skills)].join(", ")))}${detail("Опыт", `<span class="preserve">${h(user.experience || "Пока не заполнен")}</span>`)}</dl>${link("Вся анкета и удобное время →", `questionnaire/${id}`)}`,
    );
    const trainingBlock = section(
      "Знакомство с фондом",
      `<strong class="org-training-count">${n(summary.required_training_completed)} / ${n(summary.required_training_total)}</strong><p>${Number(summary.required_training_total) > 0 ? "Отмеченные материалы обязательного маршрута." : "Обязательные материалы пока не добавлены."}</p><h3>Отдельные материалы</h3><p class="org-help">Общий счётчик выше также учитывает уроки новых курсов.</p><ul class="org-training-list">${training.map((item) => `<li>${item.completed || item.completed_at ? imageIcon("3f5e6.svg") : '<span class="org-uncompleted" aria-hidden="true">○</span>'}<span>${h(item.title)}<small>${item.required ? "Обязательный" : "Дополнительный"} · ${item.completed || item.completed_at ? "Изучен" : "Не отмечен"}</small></span></li>`).join("")}</ul>${pager(data.training, key("training"))}`,
    );
    const participation = `<section class="org-card org-card-table"><div class="org-section-title"><h2>История участия</h2><span>${n(summary.total_hours)} ч · ${participationCount(summary.participation_count)}</span></div>${history.length ? table(["Дата", "Возможность", "Часы", "Статус", ""], history.map((record) => `<tr><td>${date(record.participated_on)}</td><td>${h(record.title || record.opportunity_title)}</td><td>${n(record.hours)} ч</td><td>${badge("accepted")}</td><td>${button("Исправить", "edit-hours", `data-id="${record.id}"`, true)}</td></tr>`).join("")) : emptyState("Участия пока не записаны", "Подтверждённые часы появятся здесь и в личном кабинете волонтёра.")}${pager(data.participation, key("participation"))}<div class="org-table-footer">${user.role === "volunteer" ? button("Записать участие", "user-hours", `data-user="${id}"`, true) : ""}</div></section>`;
    const notes = items(data.notes);
    const aside = `${nextApplication ? section("Ближайшее участие", `<h3>${h(nextApplication.opportunity_title)}</h3><p>${date(nextApplication.starts_at, true)}</p>${badge("accepted")}${link("Открыть мероприятие", `organizer-events/${nextApplication.opportunity_id}`, "button secondary")}`, "org-card-mint") : ""}${section("Следующий шаг", nextTask ? `<h3>${h(nextTask.title)}</h3><p>${nextTask.due_at ? date(nextTask.due_at, true) : "Срок не задан"}<br>${h(nextTask.assigned_to_name)}</p>${link("Открыть задачу →", `staff-tasks/${nextTask.id}`)}` : `<p>Открытых задач сопровождения не найдено.</p>${action("Добавить задачу", "new-task", `data-user="${id}"`, true)}`)}${manager() ? section("Внутренние заметки", `${notes.map((x) => `<article class="org-note"><p class="preserve">${h(x.body)}</p><small>${h(x.author_name || "Сотрудник")} · ${date(x.created_at, true)}</small></article>`).join("") || "<p>Заметок пока нет.</p>"}${pager(data.notes, key("notes"))}<form id="org-note-form">${textarea("Новая заметка", "body", "", true, 4000)}${note("Видно руководителям и администраторам. Это не сообщение волонтёру.")}${formEnd("Добавить заметку")}</form>`) : section("Сопровождение", `<p>Фиксируйте следующий шаг в задаче команды. Внутренние заметки доступны руководителям и администраторам.</p>`)}${user.role === "volunteer" ? section("Сказать спасибо", button("Поблагодарить", "send-thanks", `data-user="${id}"`, true)) : ""}`;
    if (
      !show(
        set,
        `${heading(user.full_name, `Профиль ${user.role === "volunteer" ? "волонтёра" : "сотрудника"} · С нами с ${date(user.created_at)}`, user.role === "volunteer" ? action("Добавить задачу", "new-task", `data-user="${id}"`) : "")}<div class="org-breadcrumb">${action("← Волонтёры", "back", 'data-route="users"', true)}${badge(user.status)}</div><div class="org-columns"><div class="org-stack">${profile}${trainingBlock}${participation}${section(
          "Отклики",
          `${
            items(data.applications)
              .map(
                (x) =>
                  `<div class="org-list-line">${link(x.opportunity_title || "Мероприятие", `organizer-events/${x.opportunity_id}`)}${badge(x.status)}</div>`,
              )
              .join("") || "<p>Откликов пока нет.</p>"
          }${pager(data.applications, key("applications"))}`,
        )}</div><aside class="org-stack">${aside}</aside></div>`,
      )
    )
      return;
    if (manager())
      bindForm(document.querySelector("#org-note-form"), async (form) => {
        await write(`/users/${id}/notes`, { body: form.get("body").trim() });
        view(key("notes")).page = 1;
        toast("Заметка сохранена");
        await refresh();
      });
  }

  async function renderEvents(set, id, readonly = false) {
    const v = view("events"),
      filter = Object.fromEntries(eventFilterKeys.map((key) => [key, v[key]]));
    if (v.archived === "true") filter.archived = "true";
    if (v.period === "upcoming") {
      filter.date_from = today();
      filter.date_to = "";
    }
    if (v.period === "past") {
      const day = new Date();
      day.setDate(day.getDate() - 1);
      filter.date_from = "";
      filter.date_to = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    }
    const [data, choices] = await Promise.all([
      getPage("/opportunities", "events", filter),
      api(
        `/opportunities/options/filters${v.archived === "true" ? "?archived=true" : ""}`,
      ),
    ]);
    if (!set.current()) return;
    const all = items(data),
      selectedId =
        id ||
        (all.some((item) => String(item.id) === ui.selectedEvent)
          ? ui.selectedEvent
          : all[0]?.id);
    let selected = all.find((x) => String(x.id) === String(selectedId));
    if (selectedId && !selected) {
      try {
        selected = (
          await api(`/opportunities/${encodeURIComponent(selectedId)}`)
        ).item;
      } catch (error) {
        if (error.status !== 404) throw error;
        selected = all[0];
      }
    }
    // Direct links to a deleted/restored record should show the matching list.
    if (
      id &&
      selected &&
      Boolean(selected.archived_at) !== (v.archived === "true")
    ) {
      v.archived = selected.archived_at ? "true" : "";
      v.page = 1;
      return renderEvents(set, id, readonly);
    }
    const key = `event:${selected?.id}:applications`,
      av = view(key);
    const [roster, pending, accepted, invitations] = await Promise.all([
      selected
        ? getPage(`/opportunities/${selected.id}/participants`, key, {
            status: av.status,
            q: av.q,
          })
        : null,
      api("/applications?status=pending&page_size=1"),
      selected
        ? getPage(
            `/opportunities/${selected.id}/participants`,
            `accepted:${selected.id}`,
            { status: "accepted" },
          )
        : null,
      selected &&
      selected.visibility === "invite_only" &&
      !readonly &&
      !selected.archived_at
        ? getPage(
            `/opportunities/${selected.id}/invitations`,
            `invitations:${selected.id}`,
            { status: "active" },
          )
        : null,
    ]);
    if (!set.current()) return;
    ui.events = new Map(all.map((x) => [String(x.id), x]));
    if (selected) {
      ui.events.set(String(selected.id), selected);
      ui.selectedEvent = String(selected.id);
    }
    const scopeTabs = `<div class="org-tabs org-event-scope" role="group" aria-label="Раздел мероприятий">${action("Активные мероприятия", "events-scope", `data-value="active" aria-pressed="${v.archived !== "true"}"`, true)}${action("Корзина", "events-scope", `data-value="archived" aria-pressed="${v.archived === "true"}"`, true)}</div>`;
    const tabs = `<div class="org-tabs" aria-label="Период встреч">${[
      ["all", "Все встречи"],
      ["upcoming", "Предстоящие"],
      ["past", "Прошедшие"],
    ]
      .map(([value, label]) =>
        action(
          label,
          "events-period",
          `data-value="${value}" aria-pressed="${(v.period || "all") === value}"`,
          true,
        ),
      )
      .join(
        "",
      )}${link(`${n(pending.total)} заявок ждут ответа`, "applications", "pill")}</div>`;
    const nav = `<aside class="org-event-list">${all.map((item) => `<button type="button" class="org-event-choice ${String(item.id) === String(selected?.id) ? "selected" : ""}" data-action="org-select-event" data-id="${item.id}" aria-pressed="${String(item.id) === String(selected?.id)}"><span class="org-eyebrow">${String(item.id) === String(selected?.id) ? "Выбранная встреча" : h([item.city, item.format].filter(Boolean).join(" · ") || "Мероприятие")}</span><h3>${h(item.title)}</h3><p>${dates(item)}</p><p>${n(item.accepted_count)}${item.capacity ? ` из ${n(item.capacity)} мест` : " участников"} подтверждены</p>${eventBadge(item)}</button>`).join("")}${pager(data, "events")}</aside>`;
    const applications = items(roster)
      .map(
        (person) =>
          `<div class="org-application"><div>${link(person.full_name, `users/${person.user_id}`, "org-person")}<small>${h(person.email || "")}</small></div><div>${badge(person.status)}<small>${n(person.required_completed)} / ${n(person.required_total)} обязательных материалов</small></div><div class="actions">${readonly ? note("Только просмотр") : person.status === "pending" && !selected.archived_at ? action("Ответить", "reply", `data-id="${person.application_id}" data-user="${person.user_id}" data-event="${selected.id}"`, true) : person.status === "accepted" ? button("Записать часы", "event-hours", `data-event="${selected.id}" data-user="${person.user_id}"`, true) : ""}</div></div>`,
      )
      .join("");
    const eventPanel = selected
      ? `<article class="org-card org-event-detail"><div class="org-mobile-detail-back">${action("← Все мероприятия", "back", 'data-route="organizer-events"', true)}</div><div class="org-section-title"><h2>${h(selected.title)}</h2>${eventBadge(selected)}</div>${selected.archived_at ? `<div class="org-archive-notice" role="status"><strong>Мероприятие в корзине</strong><p>Удалено ${date(selected.archived_at, true)}. Оно скрыто из каталога. Заявки и история участия сохранены.</p>${manager() && !readonly ? action("Восстановить мероприятие", "restore-event", `data-id="${selected.id}"`, true) : ""}</div>` : ""}<p class="preserve">${h(selected.description)}</p><dl class="org-details">${detail("Когда", dates(selected))}${detail("Где", h([selected.city, selected.location].filter(Boolean).join(" · ")))}${detail("Формат", h(selected.format || "Не указан"))}${detail("Нужна помощь", `${selected.capacity ? n(selected.capacity) : "Без ограничения"} мест · ${h(eventDuration(selected))}`)}${eventCoordination(selected)}</dl>${eventPreparation(selected)}<div class="org-divider"></div><div class="org-section-title"><h3>Заявки на участие</h3><span>${n(roster?.total)} в выборке</span></div><form id="org-roster-filter" class="org-filters">${select("Статус заявки", "status", applicationStatuses, av.status || "")}${field("Имя или почта", "q", av.q || "", "search", false, 'maxlength="120"')}<button class="button secondary" type="submit">Найти</button></form>${applications || emptyState("Пока нет заявок", "Когда волонтёр откликнется на встречу, его заявка появится здесь.")}${pager(roster, key)}<section class="org-confirmed"><h3>Подтверждённые участники · ${n(accepted?.total)}</h3><div class="org-confirmed-list">${
          items(accepted)
            .map(
              (p) =>
                `<div>${link(p.full_name, `users/${p.user_id}`)}<small>По заявке</small></div>`,
            )
            .join("") || "<p>Подтверждённых участников пока нет.</p>"
        }</div>${pager(accepted, `accepted:${selected.id}`)}${manager() && !readonly && !selected.archived_at ? (accepted?.total ? link("Уведомить участников", `campaigns/new?event_id=${selected.id}`, "button secondary") : '<button type="button" class="button secondary" disabled>Уведомить участников</button>') : ""}</section>${
          invitations
            ? `<section><div class="org-section-title"><h3>Приглашения</h3>${action("Пригласить", "invite", `data-id="${selected.id}"`, true)}</div>${
                items(invitations)
                  .map(
                    (inv) =>
                      `<div class="org-list-line"><span>${h(inv.full_name)}</span>${action("Отозвать", "revoke-invite", `data-id="${selected.id}" data-user="${inv.user_id}"`, true)}</div>`,
                  )
                  .join("") || "<p>Приглашённых пока нет.</p>"
              }${pager(invitations, `invitations:${selected.id}`)}</section>`
            : ""
        }<div class="org-inline-actions">${link("Чат участников", `event-chat/${selected.id}`, "button secondary")}${manager() && !readonly && !selected.archived_at ? link("Редактировать", `event-editor/${selected.id}`, "button secondary") : ""}${manager() && !readonly && !selected.archived_at && selected.status === "open" ? action("Закрыть набор", "close-event", `data-id="${selected.id}"`, true) : ""}${!selected.archived_at ? link("Посмотреть анонс", `event-announcement/${selected.id}`, "button secondary") : ""}${manager() && !readonly && !selected.archived_at ? action("Удалить мероприятие", "archive-event", `data-id="${selected.id}"`, true) : ""}</div>${note("Часы подтверждаются отдельной записью участия. Состояние заявки не заменяет запись часов.")}</article>`
      : emptyState(
          v.archived === "true" ? "Корзина пуста" : "Встреч пока нет",
          v.archived === "true"
            ? "Здесь будут удалённые мероприятия. Если заданы фильтры, попробуйте их сбросить."
            : "Измените фильтры или создайте первое мероприятие.",
        );
    if (
      !show(
        set,
        `${heading("Мероприятия", "Планируйте встречи, отвечайте на заявки и отмечайте участие.", manager() && !readonly ? link("Создать мероприятие", "event-editor/new", "button") : "")}${ui.published && String(ui.published) === String(selected?.id) ? '<div class="org-success" role="status"><h2>Мероприятие опубликовано</h2><p>Можно принимать заявки. Участники не добавляются автоматически.</p></div>' : ""}${scopeTabs}${v.archived === "true" ? note("Удалённые мероприятия скрыты от волонтёров. Руководитель или администратор может восстановить их с закрытым набором.") : ""}${tabs}${eventFilterForm(filter, choices, data.total)}<div class="org-events-columns ${id && selected ? "has-selection" : ""}">${nav}${eventPanel}</div>`,
      )
    )
      return;
    document
      .querySelector(".org-page")
      .classList.toggle("org-detail-open", Boolean(id && selected));
    bindForm(document.querySelector("#org-events-filter"), async (form) => {
      const next = Object.fromEntries(
        eventFilterKeys.map((key) => [key, String(form.get(key) || "").trim()]),
      );
      if (next.date_from && next.date_to && next.date_from > next.date_to)
        throw Error("Начало периода должно быть не позже окончания.");
      Object.assign(v, next, { page: 1, period: "all" });
      ui.selectedEvent = null;
      if (location.hash === "#organizer-events") await refresh(false);
      else navigate("organizer-events");
    });
    if (selected) filterForm("#org-roster-filter", key, ["status", "q"]);
    wireRemember();
  }

  async function renderAnnouncement(set, id) {
    const { item } = await api(`/opportunities/${encodeURIComponent(id)}`);
    if (!set.current()) return;
    show(
      set,
      `${heading(item.title, "Анонс мероприятия и условия участия для волонтёров.")}<div class="org-breadcrumb">${link("← К мероприятию", `organizer-events/${item.id}`, "button secondary")}${eventBadge(item)}</div><div class="org-columns"><article class="org-card org-card-table">${item.cover_url ? `<img class="org-cover" src="${h(item.cover_url)}" alt="${h(item.cover_alt || "")}">` : ""}<div class="org-announcement-description"><h2>О встрече</h2><p class="preserve">${h(item.description)}</p><div class="tags">${tags(items(item.skills))}${tags(items(item.interests))}</div>${eventPreparation(item)}</div></article><aside class="org-card org-card-mint"><h2>Участие</h2><dl class="org-details org-details-single">${detail("Когда", dates(item))}${detail("Где", h([item.city, item.location].filter(Boolean).join(" · ")))}${detail("Формат", h(item.format || "Не указан"))}${detail("Места", item.capacity ? n(item.capacity) : "Без ограничения")}${detail("Доступ", item.visibility === "invite_only" ? "По приглашению" : "Все волонтёры")}${eventCoordination(item)}</dl>${note("Это просмотр анонса сотрудником. Отклик от имени волонтёра не отправляется.")}</aside></div>`,
    );
  }

  async function renderTasks(set, id) {
    const v = view("tasks");
    const [data, open, working, done] = await Promise.all([
      getPage("/staff-tasks", "tasks", {
        mine: v.mine || false,
        status: v.status,
        overdue: v.overdue || false,
      }),
      api("/staff-tasks?status=open"),
      api("/staff-tasks?status=in_progress"),
      api("/staff-tasks?status=done"),
    ]);
    if (!set.current()) return;
    const selectedId =
      id ||
      (items(data).some((task) => String(task.id) === ui.selectedTask)
        ? ui.selectedTask
        : items(data)[0]?.id);
    let selected = items(data).find((x) => String(x.id) === String(selectedId));
    if (selectedId && !selected) {
      try {
        selected = (await api(`/staff-tasks/${encodeURIComponent(selectedId)}`))
          .item;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (!set.current()) return;
    ui.tasks = new Map(items(data).map((x) => [String(x.id), x]));
    if (selected) {
      ui.tasks.set(String(selected.id), selected);
      ui.selectedTask = String(selected.id);
    }
    const rows = items(data)
      .map(
        (task) =>
          `<tr class="${String(task.id) === String(selected?.id) ? "is-selected" : ""}"><td><button class="org-text-button" data-action="org-select-task" data-id="${task.id}">${h(task.title)}</button><small>${h(task.user_name)}</small></td><td>${h(task.assigned_to_name)}</td><td class="${task.is_overdue ? "org-overdue" : ""}">${task.due_at ? date(task.due_at, true) : "Без срока"}${task.is_overdue ? "<small>Просрочена</small>" : ""}</td><td>${badge(task.status, true)}</td></tr>`,
      )
      .join("");
    const panel = selected
      ? section(
          "Выбранная задача",
          `<h3>${h(selected.title)}</h3>${badge(selected.status, true)}<dl class="org-details org-details-single"><div class="org-divider"></div>${detail("Связано с", `${h(selected.user_name)}<br>${link("Открыть профиль →", `users/${selected.user_id}`)}`)}${detail("Ответственный", h(selected.assigned_to_name))}${detail("Срок", selected.due_at ? date(selected.due_at, true) : "Без срока")}${detail("Что нужно сделать", `<span class="preserve">${h(selected.description || "Описание не добавлено")}</span>`)}</dl>${["open", "in_progress"].includes(selected.status) ? action("Отметить готовой", "complete-task", `data-id="${selected.id}"`) : ""}${action("Изменить задачу", "edit-task", `data-id="${selected.id}"`, true)}${note(`Создана ${date(selected.created_at)} · ${selected.created_by_name || "Сотрудник"}`)}`,
        )
      : section(
          "Выбранная задача",
          "<p>Выберите задачу в таблице, чтобы посмотреть детали.</p>",
        );
    if (
      !show(
        set,
        `${heading("Задачи команды", "Следующие шаги по людям и встречам.", action("Добавить задачу", "new-task"))}<div class="org-tabs">${action("Все", "tasks-scope", `data-value="all" aria-pressed="${!v.mine}"`, true)}${action("Мои", "tasks-scope", `data-value="mine" aria-pressed="${Boolean(v.mine)}"`, true)}<button type="button" class="button secondary" disabled title="Сервер пока не поддерживает фильтр по неделе">На этой неделе · скоро</button></div><form id="org-tasks-filter" class="org-filters">${select("Статус", "status", [["", "Все статусы"], ...taskStatuses], v.status || "")}${select(
          "Срок",
          "overdue",
          [
            ["false", "Все сроки"],
            ["true", "Просроченные"],
          ],
          String(v.overdue || false),
        )}<button class="button secondary" type="submit">Применить</button></form><div class="org-metrics">${metric(n(open.total), "Новые задачи", "Нужен первый шаг")}${metric(n(working.total), "В работе", "Готовимся к следующим встречам")}${metric(n(done.total), "Готово", "Завершённые задачи")}</div><div class="org-columns org-task-columns ${id && selected ? "has-selection" : ""}"><section class="org-card org-card-table org-task-list">${rows ? table(["Задача / связь", "Ответственный", "Срок", "Статус"], rows) : emptyState("Задач не найдено", "Измените фильтры или добавьте следующий шаг.")}${pager(data, "tasks")}</section><aside class="org-task-detail"><div class="org-mobile-detail-back">${action("← Все задачи", "back", 'data-route="staff-tasks"', true)}</div>${panel}</aside></div>`,
      )
    )
      return;
    document
      .querySelector(".org-page")
      .classList.toggle("org-detail-open", Boolean(id && selected));
    filterForm("#org-tasks-filter", "tasks", ["status", "overdue"]);
  }

  function orgDialog(
    title,
    body,
    handler,
    label = "Сохранить",
    drawer = false,
  ) {
    openDialog(title, body, handler, label);
    dialog.classList.add("org-dialog");
    if (drawer) dialog.classList.add("org-drawer");
    dialog.addEventListener(
      "close",
      () => dialog.classList.remove("org-dialog", "org-drawer"),
      { once: true },
    );
  }
  async function taskDialog(taskId, userId) {
    if (!staff()) throw new APIError("Нет доступа к задачам команды.", 403);
    const token = state.view;
    const task = taskId
      ? (await api(`/staff-tasks/${encodeURIComponent(taskId)}`)).item
      : null;
    const targetId = task?.user_id || userId;
    const [person, assignee] = await Promise.all([
      targetId
        ? api(`/users/${encodeURIComponent(targetId)}?page_size=1`).then(
            (x) => x.user,
          )
        : null,
      task && manager()
        ? api(`/users/${task.assigned_to}?page_size=1`).then((x) => x.user)
        : state.user,
    ]);
    if (state.view !== token) return;
    let personLookup, assigneeLookup;
    orgDialog(
      task ? "Изменить задачу" : "Новая задача",
      `${field("Название", "title", task?.title || "", "text", true, 'minlength="3" maxlength="200"')}${lookupMarkup("task_user", "Связь с волонтёром", "Выберите волонтёра", true)}${note("Задачи пока можно связывать только с волонтёром. Связь с мероприятием появится отдельно.")}${
        manager()
          ? `${select(
              "Роль ответственного",
              "assignee_role",
              [
                ["coordinator", "Координатор"],
                ["manager", "Руководитель"],
                ["admin", "Администратор"],
              ],
              assignee?.role || state.user.role,
            )}${lookupMarkup("task_assignee", "Ответственный сотрудник", "Выберите сотрудника", true)}`
          : `<div class="notice">Ответственный: ${h(state.user.full_name)}. Координатор назначает задачи только себе.</div>`
      }${field("Срок", "due_at", localDateTime(task?.due_at), "datetime-local")}${select(
        "Приоритет",
        "priority",
        [
          ["low", "Низкий"],
          ["normal", "Обычный"],
          ["high", "Высокий"],
        ],
        task?.priority || "normal",
      )}${task ? select("Статус", "status", taskStatuses, task.status) : ""}${textarea("Что нужно сделать", "description", task?.description || "", false, 4000)}${task ? action("Загрузить актуальную задачу (сбросить ввод)", "edit-task", `data-id="${task.id}"`, true) : ""}`,
      async (form) => {
        if (personLookup.busy || personLookup.failed || !personLookup.selected)
          throw Error("Выберите волонтёра после загрузки списка.");
        if (
          manager() &&
          (assigneeLookup.busy ||
            assigneeLookup.failed ||
            !assigneeLookup.selected)
        )
          throw Error("Выберите ответственного сотрудника.");
        const payload = {
          user_id: personLookup.selected.id,
          assigned_to: manager() ? assigneeLookup.selected.id : state.user.id,
          title: form.get("title").trim(),
          description: form.get("description").trim(),
          priority: form.get("priority"),
          due_at: form.get("due_at")
            ? new Date(form.get("due_at")).toISOString()
            : null,
        };
        if (task)
          Object.assign(payload, {
            status: form.get("status"),
            expected_version: task.version,
          });
        await write(
          task ? `/staff-tasks/${task.id}` : "/staff-tasks",
          payload,
          task ? "PATCH" : "POST",
        );
        dialog.close();
        toast(task ? "Задача обновлена" : "Задача создана");
        await refresh();
      },
      "Сохранить задачу",
      true,
    );
    personLookup = createLookup(
      dialog.querySelector('[data-lookup="task_user"]'),
      {
        load: (args) => api(`/users?${qs({ ...args, role: "volunteer" })}`),
        label: (x) => `${x.full_name} · ${x.email}`,
        emptyLabel: "Выберите волонтёра",
        selectedItem: person,
      },
    );
    if (manager()) {
      assigneeLookup = createLookup(
        dialog.querySelector('[data-lookup="task_assignee"]'),
        {
          load: (args) =>
            api(
              `/users?${qs({ ...args, role: dialog.querySelector('[name="assignee_role"]').value, status: "active" })}`,
            ),
          label: (x) => `${x.full_name} · ${x.email}`,
          emptyLabel: "Выберите сотрудника",
          selectedItem: assignee,
        },
      );
      dialog.querySelector('[name="assignee_role"]').onchange = () =>
        assigneeLookup.reload({ reset: true, clear: true });
    }
    await Promise.all([personLookup.reload(), assigneeLookup?.reload()]);
  }

  const auditAction = (item) =>
    ({
      create: "Создано",
      update: "Изменено",
      status: "Изменён статус",
      role: "Изменена роль",
      apply: "Отправлен отклик",
      complete: "Завершено",
      note: "Добавлена заметка",
      thanks: "Отправлена благодарность",
      invite: "Приглашение на мероприятие",
      revoke: "Приглашение отозвано",
      export: "Выгрузка данных",
    })[item.action] || item.action;
  function auditLink(item) {
    const id = item.subject_id;
    const routes = {
      user: `users/${id}`,
      opportunity: `organizer-events/${id}`,
      staff_task: `staff-tasks/${id}`,
    };
    const labels = {
      user: "Профиль",
      opportunity: "Мероприятие",
      staff_task: "Задача",
      application: "Отклик",
      participation: "Участие",
      training: "Обучение",
    };
    const label = `${labels[item.subject_type] || item.subject_type}${id ? ` №${id}` : ""}`;
    return routes[item.subject_type] && id
      ? link(`${label} →`, routes[item.subject_type])
      : h(label);
  }
  async function renderAccess(set) {
    if (!admin()) return deny(set);
    const data = await getPage("/audit", "audit");
    show(
      set,
      `${heading("Доступ и журнал", "Полномочия ролей и история изменений в рабочем пространстве.", button("Экспорт данных", "export-data", "", true))}<div class="org-columns"><div class="org-stack">${section("Управление доступом", `<p>Роли назначает администратор в карточке пользователя. Изменения сохраняются в журнале.</p>${note("Раздел «Команда фонда» временно скрыт. Управление доступом не смешивается с волонтёрской базой.")}${link("Открыть базу волонтёров →", "users")}`)}${section("Что доступно каждой роли", `<dl class="org-role-descriptions">${detail("Администратор", "Полный рабочий кабинет, назначение ролей, статусы сотрудников, журнал и выгрузка данных.")}${detail("Руководитель", "База, встречи, задачи и часы. Курсы, рассылки, аналитика и внутренние заметки.")}${detail("Координатор", "Профили волонтёров, заявки, задачи сопровождения и подтверждение часов. Без доступа к журналу и заметкам руководителей.")}${detail("Волонтёр", "Собственный профиль, анкета, обучение, участие и сообщения.")}</dl>`)}</div><aside class="org-card"><h2 class="org-icon-heading">${imageIcon("6ae6e.svg")}Журнал действий</h2><p>Последние изменения</p>${
        items(data)
          .map(
            (item) =>
              `<article class="org-audit-item"><time>${date(item.created_at, true)}</time><strong>${h(item.actor_name || "Система")}</strong><p>${h(auditAction(item))}</p>${auditLink(item)}</article>`,
          )
          .join("") || "<p>Записей пока нет.</p>"
      }${pager(data, "audit")}${note("Записи сохраняют историю изменений и не редактируются.")}</aside></div>`,
    );
  }

  function captureEditor() {
    const form = document.querySelector("#org-event-form"),
      editor = ui.editor;
    if (!form || !editor) return;
    const data = new FormData(form);
    let changed = false;
    for (const [key, value] of data)
      if (typeof value === "string" && !key.endsWith("_search")) {
        if (String(editor.values[key] ?? "") !== value) changed = true;
        editor.values[key] = value;
      }
    if (changed) {
      editor.dirty = true;
      editor.revision++;
    }
  }
  function editorPayload(status) {
    const v = ui.editor.values;
    if (ui.editor.lookups?.some((picker) => picker.busy))
      throw Error("Дождитесь загрузки вариантов координатора и курса.");
    const starts = v.starts_at ? new Date(v.starts_at) : null,
      ends = v.ends_at ? new Date(v.ends_at) : null,
      deadline = v.application_deadline
        ? new Date(v.application_deadline)
        : null;
    if (
      (starts && !Number.isFinite(starts.getTime())) ||
      (ends && !Number.isFinite(ends.getTime())) ||
      (deadline && !Number.isFinite(deadline.getTime()))
    )
      throw Error("Укажите корректные дату и время.");
    if (starts && ends && ends <= starts)
      throw Error("Окончание должно быть позже начала.");
    if (!String(v.title || "").trim() || String(v.title).trim().length < 3)
      throw Error("Название должно содержать не меньше трёх символов.");
    if (String(v.description || "").trim().length < 3)
      throw Error("Добавьте описание мероприятия.");
    if (
      status === "open" &&
      (!starts ||
        !ends ||
        !String(v.city || "").trim() ||
        !String(v.location || "").trim())
    )
      throw Error(
        "Для публикации укажите начало, окончание, город и место проведения.",
      );
    const payload = {
      title: v.title.trim(),
      description: v.description.trim(),
      city: String(v.city || "").trim(),
      format: String(v.format || "").trim(),
      location: String(v.location || "").trim(),
      starts_at: starts?.toISOString() || null,
      ends_at: ends?.toISOString() || null,
      capacity: v.capacity ? Number(v.capacity) : null,
      status,
      visibility: v.visibility || "public",
      interests: splitTags(v.interests),
      skills: splitTags(v.skills),
      cover_url: v.cover_url || null,
      cover_alt: String(v.cover_alt || "").trim(),
      coordinator_id: v.coordinator_id ? Number(v.coordinator_id) : null,
      required_course_id: v.required_course_id
        ? Number(v.required_course_id)
        : null,
      application_deadline: deadline?.toISOString() || null,
      preparation: String(v.preparation || "").trim(),
    };
    if (payload.cover_url && !payload.cover_alt)
      throw Error(
        "Добавьте описание обложки для посетителей, использующих экранную читалку.",
      );
    return payload;
  }
  async function saveEditor(publish) {
    captureEditor();
    const editor = ui.editor;
    if (!editor || editor.busy) return;
    const errorBox = document.querySelector("#org-editor-error");
    if (errorBox) {
      errorBox.textContent = "";
      errorBox.hidden = true;
    }
    try {
      if (editor.uploading) throw Error("Дождитесь загрузки обложки.");
      const status = publish ? "open" : editor.originalStatus;
      const payload = editorPayload(status);
      const savedRevision = editor.revision;
      editor.busy = true;
      document
        .querySelectorAll('[data-action="org-save-event"]')
        .forEach((b) => (b.disabled = true));
      const result = await write(
        editor.id ? `/opportunities/${editor.id}` : "/opportunities",
        payload,
        editor.id ? "PATCH" : "POST",
      );
      const saved = result.item || result;
      const savedId = saved.id || editor.id;
      if (!savedId)
        throw Error(
          "Сервер сохранил данные, но не вернул номер мероприятия. Обновите список перед повторной попыткой.",
        );
      editor.id = String(savedId);
      editor.originalStatus = status;
      editor.dirty = editor.revision !== savedRevision;
      if (ui.editor !== editor || !errorBox?.isConnected) return;
      if (publish && !editor.dirty) {
        ui.published = String(savedId);
        ui.selectedEvent = String(savedId);
        ui.editor = null;
        navigate(`organizer-events/${savedId}`);
      } else {
        toast(
          status === "draft"
            ? "Черновик сохранён"
            : "Изменения мероприятия сохранены",
        );
        orgDialog(
          "Изменения сохранены",
          `<p>${editor.dirty ? "Отправленные данные сохранены. Изменения, сделанные во время запроса, ещё не сохранены." : status === "open" ? "Мероприятие остаётся опубликованным." : status === "closed" ? "Набор остаётся закрытым." : "Черновик доступен только сотрудникам. Все введённые данные сохранены."}</p>${action("Продолжить редактирование", "close-draft")}`,
          null,
        );
      }
    } catch (error) {
      if (ui.editor !== editor || !errorBox?.isConnected) return;
      if (error.status === 401) throw error;
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = error.message;
        errorBox.scrollIntoView({ block: "nearest" });
      } else throw error;
    } finally {
      editor.busy = false;
      if (ui.editor === editor)
        document
          .querySelectorAll('[data-action="org-save-event"]')
          .forEach((b) => (b.disabled = false));
    }
  }
  async function renderEditor(set, id = "new") {
    if (!manager()) return deny(set);
    if (
      !ui.editor ||
      (ui.editor.key !== String(id) && ui.editor.id !== String(id))
    ) {
      const event =
        id !== "new"
          ? (await api(`/opportunities/${encodeURIComponent(id)}`)).item
          : {};
      if (!set.current()) return;
      if (event.archived_at) {
        ui.editor = null;
        PortalUI.clearGuard();
        ui.events.set(String(event.id), event);
        show(
          set,
          `${heading("Мероприятие в корзине", "Для редактирования сначала восстановите мероприятие.")}${section(h(event.title), `${note("Заявки и история участия сохранены. После восстановления набор останется закрытым.")}<div class="org-inline-actions">${action("Восстановить мероприятие", "restore-event", `data-id="${event.id}"`, true)}${link("К мероприятию", `organizer-events/${event.id}`, "button secondary")}</div>`)}`,
        );
        return;
      }
      ui.editor = {
        key: String(id),
        id: event.id ? String(event.id) : null,
        step: 1,
        dirty: false,
        revision: 0,
        originalStatus: event.status || "draft",
        values: {
          ...event,
          starts_at: localDateTime(event.starts_at),
          ends_at: localDateTime(event.ends_at),
          application_deadline: localDateTime(event.application_deadline),
          skills: items(event.skills).join(", "),
          interests: items(event.interests).join(", "),
          visibility: event.visibility || "public",
        },
      };
    }
    const editor = ui.editor,
      v = editor.values,
      step = editor.step;
    const zone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "локальное время";
    const steps = `<div class="org-step-tabs">${["Описание и дата", "Участие и доступ", "Проверка"].map((title, index) => `<button type="button" class="org-step ${step === index + 1 ? "selected" : ""}" data-action="org-editor-step" data-step="${index + 1}" aria-current="${step === index + 1 ? "step" : "false"}">${index + 1}. ${title}</button>`).join("")}</div>`;
    const cover = v.cover_url
      ? `<img class="org-cover" src="${h(v.cover_url)}" alt="${h(v.cover_alt || "")}">`
      : '<div class="org-cover-placeholder">Добавьте фотографию встречи</div>';
    const summary = section(
      v.title || "Новая встреча",
      `<dl class="org-details org-details-single">${detail("Когда", v.starts_at ? date(v.starts_at, true) : "Дата не указана")}${detail("Где", h([v.city, v.location].filter(Boolean).join(" · ")))}${detail("Участие", v.capacity ? `${n(v.capacity)} мест` : "Количество мест не ограничено")}${eventCoordination(v)}</dl>`,
      "org-card-mint",
    );
    let body;
    if (step === 1)
      body = `<div class="org-columns"><section class="org-card"><h2>Описание и дата</h2>${field("Название мероприятия *", "title", v.title || "", "text", true, 'minlength="3" maxlength="200"')}${textarea("Описание и задачи волонтёров *", "description", v.description || "", true, 8000)}<div class="form-grid">${field("Направления, через запятую", "interests", v.interests || "", "text", false, 'maxlength="2000"')}${select("Формат", "format", [["", "Выберите формат"], ["Очно", "Очно"], ["Онлайн", "Онлайн"], ["Смешанный", "Смешанный"], ...(!["Очно", "Онлайн", "Смешанный", ""].includes(v.format || "") ? [[v.format, v.format]] : [])], v.format || "")}${field("Начало *", "starts_at", v.starts_at || "", "datetime-local", true)}${field("Окончание *", "ends_at", v.ends_at || "", "datetime-local", true)}</div>${note(`Часовой пояс: ${zone}. Длительность рассчитывается из начала и окончания.`)}${field("Город *", "city", v.city || "", "text", true, 'maxlength="120"')}${field("Площадка, адрес / точка встречи *", "location", v.location || "", "text", true, 'maxlength="300"')}</section><aside class="org-stack">${section("Обложка", `${cover}<label class="button secondary org-file-label">Заменить фото<input id="org-cover-file" type="file" accept="image/jpeg,image/png" class="visually-hidden"></label><p id="org-cover-state" class="org-help" role="status"></p>${note("JPEG или PNG до 10 МБ. Выберите официальное фото или изображение, на использование которого есть разрешение.")}${textarea("Описание изображения", "cover_alt", v.cover_alt || "", false, 300)}${v.cover_url ? action("Убрать обложку", "remove-cover", "", true) : ""}`)}${section("Чтобы было проще решиться", "<p>Напишите, что будет происходить и чем сможет помочь волонтёр. Укажите точное место встречи.</p>", "org-card-mint")}</aside></div>`;
    else if (step === 2)
      body = `<div class="org-columns"><section class="org-card"><h2>Чем помогут волонтёры</h2>${textarea("Описание и задачи на встрече *", "description", v.description || "", true, 8000)}<div class="form-grid">${field("Количество мест", "capacity", v.capacity || "", "number", false, 'min="1" max="100000"')}${field("Нужные навыки, через запятую", "skills", v.skills || "", "text", false, 'maxlength="2000"')}</div>${field("Интересы, через запятую", "interests", v.interests || "", "text", false, 'maxlength="2000"')}<div class="org-divider"></div><h2>Подготовка к встрече</h2>${textarea("Что нужно знать и подготовить заранее", "preparation", v.preparation || "", false, 8000)}${lookupMarkup("required_course_id", "Обучение перед встречей", "Без отдельного курса")}${note("Выберите опубликованный курс. Его содержание не копируется в событие, а прохождение не подтверждает заявку автоматически.")}${lookupMarkup("coordinator_id", "Координатор встречи", "Пока не назначен")}${note("Можно выбрать активного координатора, руководителя или администратора. Сохранённое назначение не меняется при редактировании других полей.")}</section><aside class="org-stack">${section(
        "Кто может записаться",
        `${select(
          "Доступ к встрече",
          "visibility",
          [
            ["public", "Все волонтёры"],
            ["invite_only", "По приглашению"],
          ],
          v.visibility || "public",
        )}${note("Приглашения можно отправить после первого сохранения события. Приглашение не подтверждает участие автоматически.")}<div class="org-unavailable"><label>Подтверждение участия</label><select disabled><option>После ответа координатора</option></select></div>${field("Приём заявок до", "application_deadline", v.application_deadline || "", "datetime-local")}${note(`Часовой пояс: ${zone}. После срока новые отклики не принимаются; существующие заявки сохраняются. Без срока набор продолжается до закрытия встречи или её окончания.`)}`,
      )}${summary}</aside></div>`;
    else
      body = `<div class="org-columns"><article class="org-card org-card-table">${cover}<div class="org-announcement-description"><p class="org-eyebrow">Карточка для волонтёра</p><h2>${h(v.title || "Название не заполнено")}</h2><p class="preserve">${h(v.description || "Описание не заполнено")}</p><div class="tags">${tags(splitTags(v.skills))}${tags(splitTags(v.interests))}</div>${eventPreparation(v)}${note("Перед публикацией проверьте название, условия и место. Персональные данные и заявки не входят в анонс.")}</div></article><aside class="org-stack">${summary}${section("Доступ к встрече", `<p>${v.visibility === "invite_only" ? "По приглашению" : "Все волонтёры"}</p><p>Участие подтверждает координатор.</p>${action(editor.originalStatus === "open" ? "Сохранить опубликованное" : editor.originalStatus === "closed" ? "Открыть набор снова" : "Опубликовать", "save-event", 'data-publish="true"')}`)}${section("После публикации", "<p>Встреча станет доступна выбранной аудитории. Отклики будут собираться в карточке мероприятия.</p>", "org-card-mint")}</aside></div>`;
    if (
      !show(
        set,
        `${heading(["", "Новое мероприятие", "Участие и доступ", "Всё готово к встрече?"][step], step === 1 ? "Расскажите о встрече — поможем волонтёрам найти своё дело." : step === 2 ? "Настройте, кому подойдёт встреча и что нужно сделать перед участием." : "Проверьте анонс и условия перед публикацией.")}<div class="org-breadcrumb">${action("← Все мероприятия", "leave-editor", "", true)}${eventBadge({ status: editor.originalStatus })}<span>Шаг ${step} из 3</span></div>${steps}<form id="org-event-form">${body}<div id="org-editor-error" class="notice error" role="alert" hidden></div><div class="org-editor-actions">${step > 1 ? action("Назад", "editor-step", `data-step="${step - 1}"`, true) : action(editor.originalStatus !== "draft" ? "Сохранить изменения" : "Сохранить черновик", "save-event", 'data-publish="false"', true)}${step < 3 ? action(step === 1 ? "Далее: участие" : "Проверить мероприятие", "editor-step", `data-step="${step + 1}"`) : action(editor.originalStatus === "draft" ? "Сохранить без публикации" : "Сохранить изменения", "save-event", 'data-publish="false"', true)}</div></form>${editor.id ? `<div class="org-event-danger-zone">${note("Мероприятие можно убрать из каталога с сохранением заявок и истории.")}${action("Удалить мероприятие", "archive-event", `data-id="${editor.id}"`, true)}</div>` : ""}`,
      )
    )
      return;
    const form = document.querySelector("#org-event-form");
    PortalUI.setGuard(
      () =>
        ui.editor === editor &&
        form.isConnected &&
        Boolean(editor.dirty || editor.uploading || editor.busy),
    );
    form.addEventListener("input", captureEditor);
    form.addEventListener("change", captureEditor);
    form.addEventListener("submit", (event) => event.preventDefault());
    editor.lookups = [];
    if (step === 2) {
      const selectRelation = (key, labelKey, item, title) => {
        if (ui.editor !== editor || !form.isConnected) return;
        const next = item?.id || null;
        if (String(v[key] || "") !== String(next || "")) {
          editor.dirty = true;
          editor.revision++;
        }
        v[key] = next;
        v[labelKey] = item ? title(item) : "";
      };
      const coordinator = createLookup(
        form.querySelector('[data-lookup="coordinator_id"]'),
        {
          load: (filters) =>
            api(`/opportunities/options/coordinators?${qs(filters)}`),
          label: (person) => person.full_name,
          emptyLabel: "Пока не назначен",
          selectedItem: v.coordinator_id
            ? {
                id: v.coordinator_id,
                full_name:
                  v.coordinator_name || `Сотрудник №${v.coordinator_id}`,
              }
            : null,
          onChange: (person) =>
            selectRelation(
              "coordinator_id",
              "coordinator_name",
              person,
              (item) => item.full_name,
            ),
        },
      );
      const course = createLookup(
        form.querySelector('[data-lookup="required_course_id"]'),
        {
          load: async ({ q, page }) => {
            const data = await api(
              `/courses?${qs({ q, page, status: "published" })}`,
            );
            return {
              ...data,
              pages: Math.max(
                1,
                Number(data.pages) ||
                  Math.ceil(
                    Number(data.total || 0) / Number(data.page_size || 30),
                  ),
              ),
            };
          },
          label: (item) => item.title,
          emptyLabel: "Без отдельного курса",
          selectedItem: v.required_course_id
            ? {
                id: v.required_course_id,
                title:
                  v.required_course_title || `Курс №${v.required_course_id}`,
              }
            : null,
          onChange: (item) =>
            selectRelation(
              "required_course_id",
              "required_course_title",
              item,
              (selected) => selected.title,
            ),
        },
      );
      editor.lookups = [coordinator, course];
      void Promise.all(editor.lookups.map((picker) => picker.reload()));
    }
    const upload = document.querySelector("#org-cover-file");
    if (upload)
      upload.onchange = async () => {
        const file = upload.files?.[0],
          status = document.querySelector("#org-cover-state");
        if (!file) return;
        if (
          !["image/jpeg", "image/png"].includes(file.type) ||
          file.size > 10 * 1024 * 1024
        ) {
          status.textContent = "Выберите JPEG или PNG размером до 10 МБ.";
          upload.value = "";
          return;
        }
        const activeEditor = ui.editor;
        activeEditor.uploading = true;
        upload.disabled = true;
        status.textContent = "Загружаем обложку…";
        try {
          if (!state.csrf) await refreshCSRF();
          const response = await fetch("/api/uploads/images", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": file.type, "X-CSRF-Token": state.csrf },
            body: file,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok)
            throw Error(result.error || "Не удалось загрузить изображение.");
          if (!/^\/uploads\/[a-f0-9]{64}\.(png|jpg)$/.test(result.url || ""))
            throw Error("Сервер вернул некорректный адрес изображения.");
          activeEditor.values.cover_url = result.url;
          activeEditor.dirty = true;
          activeEditor.revision++;
          if (ui.editor === activeEditor && upload.isConnected) {
            captureEditor();
            await refresh();
          }
        } catch (error) {
          if (status.isConnected) status.textContent = error.message;
        } finally {
          activeEditor.uploading = false;
          if (upload.isConnected) upload.disabled = false;
        }
      };
  }

  async function invitationDialog(eventId) {
    let picker;
    orgDialog(
      "Пригласить на мероприятие",
      `${lookupMarkup("invite_user", "Волонтёр", "Выберите волонтёра", true)}${note("Приглашение открывает доступ к встрече. Волонтёр затем откликается, а координатор подтверждает участие.")}`,
      async () => {
        if (picker.busy || picker.failed || !picker.selected)
          throw Error("Выберите волонтёра после загрузки списка.");
        await write(`/opportunities/${eventId}/invitations`, {
          user_ids: [picker.selected.id],
        });
        dialog.close();
        toast("Приглашение сохранено");
        await refresh();
      },
      "Пригласить",
    );
    picker = createLookup(dialog.querySelector('[data-lookup="invite_user"]'), {
      load: (args) => api(`/users?${qs({ ...args, role: "volunteer" })}`),
      label: (x) =>
        `${x.full_name} · ${x.email} · ${statuses[x.status] || x.status}`,
      emptyLabel: "Выберите волонтёра",
    });
    await picker.reload();
  }
  function newUserDialog() {
    if (!manager())
      throw new APIError(
        "Создание профиля доступно руководителю и администратору.",
        403,
      );
    const viewToken = state.view;
    orgDialog(
      "Добавить волонтёра",
      `${field("Имя и фамилия", "full_name", "", "text", true, 'minlength="2" maxlength="120" autocomplete="off"')}${field("Электронная почта", "email", "", "email", true, 'maxlength="254" autocomplete="off"')}${textarea("Комментарий команды", "comment", "", false, 4000)}${note("Создание карточки не отправляет приглашение, не подтверждает почту и не фиксирует согласия за волонтёра.")}`,
      async (form, element) => {
        const result = await write("/users", {
          full_name: form.get("full_name").trim(),
          email: form.get("email").trim(),
          comment: form.get("comment").trim(),
        });
        if (state.view !== viewToken || !element.isConnected || !dialog.open)
          return;
        dialog.close();
        toast("Профиль создан");
        navigate(`users/${result.user.id}`);
      },
      "Сохранить профиль",
      true,
    );
  }
  function userStatusDialog(id) {
    const user = ui.users.get(String(id));
    if (!user) throw Error("Обновите профиль и повторите действие.");
    if (user.role !== "volunteer" && !admin())
      throw new APIError("Статус сотрудника меняет администратор.", 403);
    orgDialog(
      "Изменить статус",
      `${select("Состояние профиля", "status", userStatuses, user.status)}${note("Закрытый профиль сохраняет историю, но аккаунт не сможет войти. Статус знакомства отдельно от нового профиля пока не поддерживается.")}`,
      async (form) => {
        await write(
          `/users/${id}/status`,
          { status: form.get("status") },
          "PATCH",
        );
        dialog.close();
        toast("Статус обновлён");
        await refresh();
      },
    );
  }
  function userRoleDialog(id) {
    if (!admin())
      throw new APIError("Назначать роли может администратор.", 403);
    const user = ui.users.get(String(id));
    if (!user) throw Error("Обновите профиль.");
    if (String(id) === String(state.user.id))
      throw Error("Свою роль изменить нельзя.");
    orgDialog(
      "Права доступа",
      `${select("Роль", "role", Object.entries(roleLabels), user.role)}${note("Изменение влияет на доступ к данным и сохраняется в журнале.")}`,
      async (form) => {
        await write(`/users/${id}/role`, { role: form.get("role") }, "PATCH");
        dialog.close();
        toast("Роль обновлена");
        await refresh();
      },
    );
  }

  async function handleAction(name, element) {
    if (!name.startsWith("org-")) return false;
    if (!staff()) throw new APIError("Недостаточно прав.", 403);
    const actionName = name.slice(4),
      id = element.dataset.id;
    if (actionName === "page") {
      view(element.dataset.key).page = Math.max(
        1,
        Number(element.dataset.page),
      );
      if (element.dataset.key === "events") {
        ui.selectedEvent = null;
        if (location.hash !== "#organizer-events") {
          navigate("organizer-events");
          return true;
        }
      }
      await refresh();
    } else if (actionName === "users-layout") {
      if (!["cards", "table"].includes(element.dataset.layout)) return true;
      view("users").layout = element.dataset.layout;
      await refresh();
    } else if (actionName === "reset") {
      ui.views[element.dataset.key] = {
        page: 1,
        layout: view(element.dataset.key).layout,
        ...(element.dataset.key === "events"
          ? { archived: view("events").archived }
          : {}),
      };
      if (element.dataset.key === "events") {
        ui.selectedEvent = null;
        if (location.hash !== "#organizer-events") {
          navigate("organizer-events");
          return true;
        }
      }
      await refresh(false);
    } else if (actionName === "back") {
      ui.restore = `#${element.dataset.route}`;
      navigate(element.dataset.route);
    } else if (actionName === "add-user") newUserDialog();
    else if (actionName === "user-status") userStatusDialog(id);
    else if (actionName === "user-role") userRoleDialog(id);
    else if (actionName === "new-task")
      await taskDialog(null, element.dataset.user);
    else if (actionName === "edit-task") await taskDialog(id);
    else if (actionName === "select-task") {
      remember();
      ui.selectedTask = String(id);
      navigate(`staff-tasks/${id}`);
    } else if (actionName === "tasks-scope") {
      view("tasks").mine = element.dataset.value === "mine";
      view("tasks").page = 1;
      await refresh();
    } else if (actionName === "complete-task") {
      const task = ui.tasks.get(String(id));
      if (!task) throw Error("Обновите список задач.");
      await write(
        `/staff-tasks/${id}`,
        { status: "done", expected_version: task.version },
        "PATCH",
      );
      toast("Задача завершена");
      await refresh();
    } else if (actionName === "events-scope") {
      if (!["active", "archived"].includes(element.dataset.value)) return true;
      ui.views.events = {
        page: 1,
        archived: element.dataset.value === "archived" ? "true" : "",
      };
      ui.selectedEvent = null;
      if (location.hash === "#organizer-events") await refresh(false);
      else navigate("organizer-events");
    } else if (
      actionName === "archive-event" ||
      actionName === "restore-event"
    ) {
      if (!manager())
        throw new APIError(
          "Удалять и восстанавливать мероприятия может руководитель или администратор.",
          403,
        );
      const editing = ui.editor?.id === String(id);
      if (editing) captureEditor();
      if (editing && (ui.editor.busy || ui.editor.uploading))
        throw Error("Дождитесь сохранения мероприятия и загрузки обложки.");
      const event = editing ? ui.editor.values : ui.events.get(String(id));
      if (!event) throw Error("Обновите список мероприятий.");
      const restore = actionName === "restore-event";
      orgDialog(
        restore ? "Восстановить мероприятие?" : "Удалить мероприятие?",
        `<p><strong>${h(event.title)}</strong></p><p>${restore ? (event.status === "draft" ? "Мероприятие вернётся в черновики. Оно останется неопубликованным." : "Мероприятие вернётся в основной список с закрытым набором. Заявки и история участия сохранятся. Открыть набор можно будет в редакторе.") : "Мероприятие исчезнет из каталога и перейдёт в корзину. Заявки и история участия сохранятся; мероприятие можно будет восстановить."}</p>${editing && ui.editor.dirty ? note("Несохранённые изменения редактора будут потеряны.") : ""}`,
        async () => {
          await write(
            `/opportunities/${id}/${restore ? "restore" : "archive"}`,
            {},
          );
          dialog.close();
          if (editing) {
            ui.editor = null;
            PortalUI.clearGuard();
          }
          ui.events.delete(String(id));
          ui.selectedEvent = null;
          ui.published = null;
          view("events").page = 1;
          toast(
            restore
              ? event.status === "draft"
                ? "Черновик восстановлен"
                : "Мероприятие восстановлено. Набор закрыт."
              : "Мероприятие перемещено в корзину",
          );
          if (location.hash === "#organizer-events") await refresh(false);
          else navigate("organizer-events");
        },
        restore ? "Восстановить" : "Удалить мероприятие",
      );
    } else if (actionName === "events-period") {
      view("events").period = element.dataset.value;
      view("events").date_from = "";
      view("events").date_to = "";
      view("events").page = 1;
      ui.selectedEvent = null;
      if (location.hash === "#organizer-events") await refresh(false);
      else navigate("organizer-events");
    } else if (actionName === "close-event") {
      if (!manager())
        throw new APIError(
          "Закрывать набор может руководитель или администратор.",
          403,
        );
      orgDialog(
        "Закрыть набор?",
        "<p>Новые отклики перестанут приниматься. Заявки и история участия сохранятся.</p>",
        async () => {
          await write(`/opportunities/${id}`, { status: "closed" }, "PATCH");
          dialog.close();
          toast("Набор закрыт");
          await refresh();
        },
        "Закрыть набор",
      );
    } else if (actionName === "select-event") {
      remember();
      ui.selectedEvent = String(id);
      navigate(`organizer-events/${id}`);
    } else if (actionName === "reply") {
      orgDialog(
        "Ответить на заявку",
        `${link("Посмотреть профиль волонтёра →", `users/${element.dataset.user}`)}${select(
          "Решение",
          "status",
          [
            ["accepted", "Подтвердить участие"],
            ["rejected", "Не подходит сейчас"],
          ],
          "accepted",
        )}${note("Подтверждение проверит доступ к встрече и свободные места. Волонтёр увидит результат в уведомлениях.")}`,
        async (form) => {
          await write(
            `/applications/${id}`,
            { status: form.get("status") },
            "PATCH",
          );
          dialog.close();
          toast("Решение сохранено");
          await refresh();
        },
        "Сохранить решение",
      );
    } else if (actionName === "invite") await invitationDialog(id);
    else if (actionName === "revoke-invite") {
      orgDialog(
        "Отозвать приглашение",
        `<p>Волонтёр потеряет доступ к закрытой встрече. Ожидающий отклик будет отозван. История участия сохраняется.</p>`,
        async () => {
          await write(
            `/opportunities/${id}/invitations/${element.dataset.user}`,
            { status: "revoked" },
            "PATCH",
          );
          dialog.close();
          toast("Приглашение отозвано");
          await refresh();
        },
        "Отозвать приглашение",
      );
    } else if (actionName === "editor-step") {
      captureEditor();
      if (ui.editor?.uploading) throw Error("Дождитесь загрузки обложки.");
      const target = Number(element.dataset.step);
      if (![1, 2, 3].includes(target)) return true;
      if (target === 3) editorPayload("draft");
      ui.editor.step = target;
      await refresh(false);
      window.scrollTo({ top: 0, behavior: "instant" });
    } else if (actionName === "save-event") {
      if (!manager()) throw new APIError("Недостаточно прав.", 403);
      await saveEditor(element.dataset.publish === "true");
    } else if (actionName === "remove-cover") {
      captureEditor();
      ui.editor.values.cover_url = null;
      ui.editor.values.cover_alt = "";
      ui.editor.dirty = true;
      ui.editor.revision++;
      await refresh();
    } else if (actionName === "leave-editor") {
      captureEditor();
      if (!ui.editor?.dirty && !ui.editor?.uploading && !ui.editor?.busy) {
        ui.editor = null;
        PortalUI.clearGuard();
        navigate("organizer-events");
        return true;
      }
      orgDialog(
        "Вернуться к мероприятиям?",
        `<p>Несохранённые изменения этого редактора будут потеряны.</p>`,
        async () => {
          dialog.close();
          ui.editor = null;
          PortalUI.clearGuard();
          navigate("organizer-events");
        },
        "Вернуться без сохранения",
      );
    } else if (actionName === "close-draft") dialog.close();
    return true;
  }
  const routes = new Set([
    "users",
    "organizer-events",
    "event-announcement",
    "event-editor",
    "staff-tasks",
    "access",
  ]);
  async function render(route, id, set) {
    if (!routes.has(route)) return false;
    if (!staff()) {
      deny(set);
      return true;
    }
    if (route === "users")
      id ? await renderUser(set, id) : await renderUsers(set);
    if (route === "organizer-events") await renderEvents(set, id);
    if (route === "event-announcement") await renderAnnouncement(set, id);
    if (route === "event-editor") await renderEditor(set, id || "new");
    if (route === "staff-tasks") await renderTasks(set, id);
    if (route === "access") await renderAccess(set);
    return true;
  }
  function reset() {
    ui.views = {};
    ui.users.clear();
    ui.tasks.clear();
    ui.events.clear();
    ui.editor = null;
    ui.selectedEvent = null;
    ui.selectedTask = null;
    ui.published = null;
    ui.scroll.clear();
    ui.restore = null;
  }
  return {
    handles: (route) => routes.has(route),
    render,
    handleAction,
    reset,
  };
})();
