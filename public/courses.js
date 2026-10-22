/* Isolated learning module. The shell supplies authenticated API helpers. */
(() => {
  "use strict";
  const escape = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const h = escape,
    uuid = () => crypto.randomUUID(),
    clone = (v) => JSON.parse(JSON.stringify(v));
  const canEdit = (u) => ["manager", "admin"].includes(u.role);
  const isStaff = (u) => u.role !== "volunteer";
  const kind = { video: "Видео", text: "Текст", quiz: "Тест" };
  const steps = [
    ["description", "Описание"],
    ["program", "Программа"],
    ["quiz", "Тест"],
    ["access", "Доступ и публикация"],
  ];
  const catalogs = new Map(),
    drafts = new Map(),
    attempts = new Map(),
    results = new Map();
  let ctx,
    current,
    root,
    controller,
    generation = 0,
    searchTimer,
    saveTimer,
    resizeObserver,
    lastUser;
  const courseURL = (id, lessonId) =>
    `#training/course/${id}${lessonId ? `/lesson/${lessonId}` : ""}`;
  const quizKey = (c, l) => `${ctx.user.id}:${c.id}:${l.id}:${l.revision}`;
  const editorURL = (id, tab = "description") => `#training/edit/${id}/${tab}`;
  const imageURL = (v) =>
    /^\/(assets|uploads)\/[\w./-]+$/.test(v || "") && !v.includes("..")
      ? v
      : "";
  const resourceURL = (v) => {
    if (imageURL(v)) return v;
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  const link = (text, href, secondary = false) =>
    `<a class="pc-button${secondary ? " pc-secondary" : ""}" href="${h(href)}">${h(text)}</a>`;
  const button = (text, action, attrs = "", secondary = false) =>
    `<button type="button" class="pc-button${secondary ? " pc-secondary" : ""}" data-pc-action="${action}" ${attrs}>${h(text)}</button>`;
  const notice = (text, error = false) =>
    `<div class="pc-notice${error ? " pc-error" : ""}" ${error ? 'role="alert"' : ""}>${h(text)}</div>`;
  const photo = (url, alt, cls = "") =>
    imageURL(url)
      ? `<img class="${cls}" src="${h(url)}" alt="${h(alt || "")}" loading="lazy">`
      : "";
  const bar = (percent, label = "Прогресс курса") =>
    `<progress class="pc-progress" max="100" value="${percent}" aria-label="${h(label)}">${percent}%</progress>`;
  const percent = (c) =>
    c.lesson_count ? Math.round((c.completed / c.lesson_count) * 100) : 0;
  const status = (c) =>
    `<span class="pc-status${!c.archived_at && c.status === "published" ? " pc-published" : ""}">${c.archived_at ? "В корзине" : c.status === "published" ? "Опубликован" : "Черновик"}</span>`;
  function state() {
    const key = String(ctx.user.id);
    if (!catalogs.has(key)) {
      let expanded = false;
      try {
        expanded = localStorage.getItem(`course-required:${key}`) === "true";
      } catch {}
      catalogs.set(key, {
        q: "",
        topic: "",
        status: "",
        type: "",
        sort: "newest",
        archived: "false",
        history: "false",
        page: 1,
        scroll: 0,
        expanded,
      });
    }
    return catalogs.get(key);
  }
  function listen(target, event, fn, options = {}) {
    target.addEventListener(event, fn, {
      ...options,
      signal: controller.signal,
    });
  }
  function valid(token = generation) {
    return token === generation && (!ctx.set.current || ctx.set.current());
  }
  function error(e) {
    if (e.code === "STALE_COURSE_VIEW") return;
    if (root?.isConnected) {
      const el = root.querySelector(".pc-action-error");
      if (el) {
        el.textContent = e.message;
        el.hidden = false;
      }
    }
    ctx?.toast?.(e.message, true);
  }
  async function interact(path, body, method) {
    const token = generation,
      response = await ctx.write(path, body, method);
    if (!valid(token))
      throw Object.assign(new Error("Экран уже изменился"), {
        code: "STALE_COURSE_VIEW",
      });
    return response;
  }
  function mount(html, klass = "") {
    if (!valid()) return;
    ctx.set(
      `<section class="pc ${klass}" data-courses><div class="pc-action-error" role="alert" hidden></div>${html}</section>`,
    );
    root = document.querySelector("[data-courses]");
    if (!root) return;
    listen(root, "click", (event) => {
      const control = event.target.closest("[data-pc-action]");
      if (control) {
        event.preventDefault();
        handleAction(control.dataset.pcAction, control).catch(error);
      }
    });
  }
  function fitColumns(
    selector = ".pc-columns",
    scrolling = ".pc-scroll",
    aside = ".pc-aside",
    reserve = 24,
  ) {
    const columns = root?.querySelector(selector);
    if (!columns) return;
    const adjust = () => {
      if (!columns.isConnected) return;
      const available =
        window.innerHeight - columns.getBoundingClientRect().top - reserve;
      const right = columns.querySelector(aside),
        scroll = columns.querySelector(scrolling);
      const fit =
        window.innerWidth >= 1024 &&
        available >= Math.max(320, (right?.scrollHeight || 0) + 8);
      columns.classList.toggle("pc-fitted", fit);
      if (scroll)
        scroll.style.maxHeight = fit ? `${Math.floor(available)}px` : "none";
    };
    adjust();
    listen(window, "resize", adjust);
    resizeObserver = new ResizeObserver(adjust);
    resizeObserver.observe(columns.querySelector(aside) || columns);
  }
  function card(c, side = false) {
    const progress = percent(c);
    const title = `<a class="pc-course-title" href="${courseURL(c.id, c.last_lesson_id)}">${h(c.title)}</a>`;
    if (side)
      return `<article class="pc-card pc-resume"><p class="pc-eyebrow">Дополнительно</p>${photo(c.cover_url, c.cover_alt, "pc-course-photo")}<h2>${title}</h2><p>${h(c.description)}</p><div class="pc-card-progress">${bar(progress)}<p class="pc-small">Пройдено ${progress}% · ${c.completed} из ${c.lesson_count} уроков</p></div>${link(progress === 100 ? "К материалам курса" : "Продолжить обучение", courseURL(c.id, c.last_lesson_id))}</article>`;
    const caption = `<div class="pc-course-caption"><p class="pc-eyebrow">${c.required ? "Обязательный курс" : "Дополнительный курс"}</p><span class="pc-course-chip">${c.required ? "Первый шаг" : "По желанию"}</span></div>`;
    const action = c.enrolled
      ? link(
          progress === 100 ? "К материалам курса" : "Продолжить обучение",
          courseURL(c.id, c.last_lesson_id),
        )
      : button("Записаться на курс", "enroll", `data-course-id="${c.id}"`);
    const progressText = c.enrolled
      ? `<strong>${progress === 100 ? "Курс пройден" : `Пройдено ${progress}%`}</strong><span>${c.completed} из ${c.lesson_count} уроков</span>`
      : "<strong>Вы ещё не записаны</strong><span>Можно пройти в удобное время</span>";
    return `<article class="pc-card pc-course-card"><div class="pc-card-pad pc-course-heading">${caption}<h2>${title}</h2></div>${photo(c.cover_url, c.cover_alt, "pc-course-photo")}<div class="pc-card-pad"><p class="pc-course-description">${h(c.description)}</p><p class="pc-small pc-course-meta">${c.lesson_count} уроков${c.minutes ? ` · ${c.minutes} минут` : ""}${c.topic ? ` · ${h(c.topic)}` : ""}</p>${c.enrolled ? bar(progress) : ""}<div class="pc-course-enrollment"><p class="pc-course-progress-copy">${progressText}</p>${action}</div></div></article>`;
  }

  function legacyRows(items) {
    return items
      .map(
        (t) =>
          `<a class="pc-lesson-link" href="#training/material/${t.id}"><span class="pc-number">${t.completed ? "✓" : "→"}</span><span><strong>${h(t.title)}</strong><small>${t.completed ? "Материал пройден" : "Отдельный материал"}</small></span></a>`,
      )
      .join("");
  }
  async function catalog() {
    const token = generation,
      s = state(),
      staff = isStaff(ctx.user);
    const query = () =>
      new URLSearchParams({
        q: s.q,
        topic: s.topic,
        status: s.status,
        type: staff ? s.type : s.history === "true" ? "" : "optional",
        archived: staff ? s.archived : "false",
        history: staff ? "false" : s.history,
        sort: s.sort,
        page: String(s.page),
      });
    const [data, legacy, learning] = await Promise.all([
      ctx.api(`/courses?${query()}`),
      ctx.api("/training?page_size=100"),
      ctx.api("/courses/summary"),
    ]);
    if (!valid(token)) return;
    current = { type: "catalog", data, legacy };
    const requiredLegacy = legacy.items.filter(
      (x) => x.required && x.published,
    );
    const requiredTotal = learning.summary.required_total;
    const requiredDone = learning.summary.required_completed;
    const requiredPercent = requiredTotal
      ? Math.round((requiredDone / requiredTotal) * 100)
      : 0;
    const catalogTopics = [...data.topics];
    if (s.topic && !catalogTopics.includes(s.topic))
      catalogTopics.push(s.topic);
    const collection = `<label class="pc-field"><span>Раздел</span><select name="${staff ? "archived" : "history"}">${options(
      staff
        ? [
            ["false", "Действующие курсы"],
            ["true", "Корзина"],
          ]
        : [
            ["false", "Каталог курсов"],
            ["true", "Мои курсы из архива"],
          ],
      staff ? s.archived : s.history,
    )}</select></label>`;
    const filters = `<form class="pc-filters" data-pc-search aria-label="Фильтры курсов"><label class="pc-field"><span>Поиск по курсам</span><input name="q" value="${h(s.q)}" placeholder="Название или тема курса" maxlength="120" type="search"></label><div class="pc-filter-row">${collection}<label class="pc-field"><span>Тема курса</span><select name="topic">${options([["", "Все темы"], ...catalogTopics.map((x) => [x, x])], s.topic)}</select></label>${
      staff
        ? `<label class="pc-field"><span>Статус публикации</span><select name="status">${options(
            [
              ["", "Все статусы"],
              ["draft", "Черновики"],
              ["published", "Опубликованные"],
            ],
            s.status,
          )}</select></label><label class="pc-field"><span>Тип курса</span><select name="type">${options(
            [
              ["", "Все типы"],
              ["required", "Обязательные"],
              ["optional", "Дополнительные"],
            ],
            s.type,
          )}</select></label>`
        : `<label class="pc-field"><span>Моё обучение</span><select name="status">${options(
            [
              ["", "Все статусы"],
              ["not_started", "Не записан"],
              ["in_progress", "В процессе"],
              ["completed", "Завершён"],
            ],
            s.status,
          )}</select></label>`
    }<label class="pc-field"><span>Сортировка</span><select name="sort">${options(
      [
        ["newest", "Сначала новые"],
        ["title", "По названию"],
        ["duration", "Сначала короткие"],
      ],
      s.sort,
    )}</select></label></div><div class="pc-filter-actions"><button class="pc-button" type="submit">Применить</button><button class="pc-text-button" type="button" data-pc-action="reset-search">Сбросить</button><span class="pc-count pc-small" role="status" aria-live="polite">Найдено: ${data.total}</span></div></form>`;
    const title = `<header class="pc-heading"><div><h1>${staff ? "Курсы" : "Учиться, чтобы быть рядом"}</h1><p>${staff ? "Материалы, которые помогают волонтёрам чувствовать себя увереннее." : "Знакомимся с фондом, учимся бережному общению и готовимся помогать."}</p></div>${canEdit(ctx.user) ? link("Создать курс", "#training/new") : ""}</header>`;
    if (staff) {
      mount(
        `${title}<div class="pc-metrics">${[
          [data.summary.total, "Курса"],
          [data.summary.published, "Опубликовано"],
          [data.summary.drafts, "Черновиков"],
        ]
          .map(
            ([n, label]) =>
              `<div class="pc-card"><strong>${n}</strong><span>${label}</span></div>`,
          )
          .join(
            "",
          )}</div>${filters}<div class="pc-results">${staffResults(data)}</div><section class="pc-card pc-card-pad"><h2>От идеи до готового курса</h2><p>Добавьте описание и обложку, соберите уроки, настройте завершение — затем проверьте курс глазами волонтёра.</p></section>${legacy.items.length ? `<section class="pc-card pc-card-pad"><h2>Ранее добавленные материалы</h2>${legacyRows(legacy.items)}</section>` : ""}`,
        "pc-organizer",
      );
    } else {
      const required = `<section class="pc-card pc-card-pad pc-required"><button class="pc-accordion-button" type="button" data-pc-action="accordion" aria-expanded="${s.expanded}" aria-controls="pc-required-materials"><span><span class="pc-eyebrow">Обязательный маршрут</span><strong>С чего начинается участие</strong><small>${requiredDone} из ${requiredTotal} материалов пройдено</small></span><span class="pc-accordion-label">${s.expanded ? "Свернуть" : "Развернуть"}<img src="/assets/figma/72416.svg" alt=""></span></button><div id="pc-required-materials" class="pc-accordion-content" ${s.expanded ? "" : "hidden"}>${data.required.map((c) => `<a class="pc-lesson-link" href="${courseURL(c.id, c.last_lesson_id)}"><span class="pc-number">${percent(c) === 100 ? "✓" : "→"}</span><span><strong>${h(c.title)}</strong><small>${c.completed} из ${c.lesson_count} уроков</small></span></a>`).join("")}${legacyRows(requiredLegacy)}${!requiredTotal ? `<p>Организатор ещё не добавил обязательные материалы.</p>` : ""}</div></section>`;
      mount(
        `${title}<section class="pc-route-summary"><div><p class="pc-eyebrow">Обязательный маршрут</p><h2>${requiredTotal && requiredDone === requiredTotal ? "Вы готовы к участию" : requiredTotal ? "Готовимся к участию" : "Ваш первый шаг"}</h2><p>${requiredDone} из ${requiredTotal} материалов пройдены.</p>${bar(requiredPercent, "Обязательный маршрут")}</div><div class="pc-summary-number"><strong>${requiredPercent}%</strong><span>${requiredTotal && requiredDone === requiredTotal ? "Первый шаг сделан!" : "В своём темпе"}</span></div></section><div class="pc-columns"><div class="pc-scroll" tabindex="0" role="region" aria-label="Каталог курсов">${required}${filters}<div class="pc-results">${learnerResults(data)}</div>${legacy.items.some((x) => !x.required) ? `<section class="pc-card pc-card-pad"><h2>Отдельные материалы</h2>${legacyRows(legacy.items.filter((x) => !x.required))}</section>` : ""}</div><aside class="pc-aside">${data.continuation ? card(data.continuation, true) : `<section class="pc-card pc-card-pad"><p class="pc-eyebrow">Дополнительно</p><h2>Учиться в своём темпе</h2><p>Выберите курс и запишитесь. Здесь появится курс, к которому вы сможете вернуться.</p></section>`}</aside></div>`,
      );
      const scroll = root.querySelector(".pc-scroll");
      scroll.scrollTop = s.scroll;
      listen(scroll, "scroll", () => {
        s.scroll = scroll.scrollTop;
      });
      fitColumns();
    }
    if (legacy.total > legacy.items.length)
      root.insertAdjacentHTML(
        "beforeend",
        `<div>${link(`Все отдельные материалы (${legacy.total})`, "#training/materials", true)}</div>`,
      );
    if (!staff && data.required_count > data.required.length)
      root.insertAdjacentHTML(
        "beforeend",
        `<div>${link(`Все обязательные курсы (${data.required_count})`, "#training/required", true)}</div>`,
      );
    const form = root.querySelector("[data-pc-search]");
    let request = 0;
    const refresh = async () => {
      const attempt = ++request;
      const fields = new FormData(form);
      for (const key of [
        "q",
        "status",
        "topic",
        "type",
        "sort",
        "archived",
        "history",
      ])
        if (fields.has(key)) s[key] = String(fields.get(key));
      const region = root.querySelector(".pc-results");
      region.setAttribute("aria-busy", "true");
      try {
        const next = await ctx.api(`/courses?${query()}`);
        if (!valid(token) || attempt !== request) return;
        current.data = next;
        const topics = [...next.topics];
        if (s.topic && !topics.includes(s.topic)) topics.push(s.topic);
        form.elements.topic.innerHTML = options(
          [["", "Все темы"], ...topics.map((x) => [x, x])],
          s.topic,
        );
        region.innerHTML = staff ? staffResults(next) : learnerResults(next);
        root.querySelector(".pc-count").textContent = `Найдено: ${next.total}`;
      } catch (e) {
        if (valid(token)) error(e);
      } finally {
        if (valid(token) && attempt === request)
          region.removeAttribute("aria-busy");
      }
    };
    current.refresh = refresh;
    listen(form, "input", () => {
      s.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refresh, 300);
    });
    listen(form, "change", (e) => {
      if (e.target.tagName === "SELECT") {
        s.page = 1;
        clearTimeout(searchTimer);
        refresh();
      }
    });
    listen(form, "submit", (e) => {
      e.preventDefault();
      s.page = 1;
      clearTimeout(searchTimer);
      refresh();
    });
  }
  const options = (items, value) =>
    items
      .map(
        ([key, label]) =>
          `<option value="${h(key)}" ${String(key) === String(value) ? "selected" : ""}>${h(label)}</option>`,
      )
      .join("");
  function pager(data) {
    return data.total > data.page_size
      ? `<nav class="pc-pager" aria-label="Страницы курсов">${button("Назад", "page", `data-page="${data.page - 1}" ${data.page === 1 ? "disabled" : ""}`, true)}<span>Страница ${data.page} из ${Math.ceil(data.total / data.page_size)}</span>${button("Далее", "page", `data-page="${data.page + 1}" ${data.page * data.page_size >= data.total ? "disabled" : ""}`, true)}</nav>`
      : "";
  }
  function learnerResults(data) {
    return `${data.items.length ? data.items.map((c) => card(c)).join("") : notice("По этим условиям курсов пока нет.")}${pager(data)}`;
  }
  function courseArchiveButton(c) {
    return canEdit(ctx.user)
      ? button(
          c.archived_at ? "Восстановить" : "Удалить",
          c.archived_at ? "restore-course" : "archive-course",
          `data-course-id="${c.id}"`,
          true,
        )
      : "";
  }
  function staffResults(data) {
    return `<section class="pc-card"><div class="pc-card-pad pc-inline"><h2>${data.archived ? "Корзина курсов" : "Все курсы"}</h2><span>${data.total}</span></div>${data.archived ? notice("Удалённые курсы скрыты из каталога. Материалы и прогресс участников сохранены. При восстановлении вернётся прежний статус публикации.") : ""}<div class="pc-table-wrap" tabindex="0" role="region" aria-label="Список курсов"><table class="pc-table"><thead><tr><th>Курс</th><th>Статус</th><th>Участники</th><th>Действия</th></tr></thead><tbody>${data.items.map((c) => `<tr><td><strong>${h(c.title)}</strong><small>${c.required ? "Обязательный" : "Необязательный"} · ${c.lesson_count} уроков · ${c.minutes} минут</small></td><td>${status(c)}</td><td>${c.participants} участников<small>${c.completions} завершили</small></td><td><div class="pc-record-actions">${link(canEdit(ctx.user) && !c.archived_at ? "Редактировать" : "Посмотреть", canEdit(ctx.user) ? editorURL(c.id) : courseURL(c.id), true)}${courseArchiveButton(c)}</div></td></tr>`).join("") || `<tr><td colspan="4">${data.archived ? "Корзина пуста" : "Курсов по этим условиям нет"}</td></tr>`}</tbody></table></div>${pager(data)}</section>`;
  }
  function paragraphs(text) {
    return String(text || "")
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((p) => `<p>${h(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
  function article(l) {
    return `<article class="pc-card pc-article"><p class="pc-eyebrow">${l.type === "text" ? "Читать в своём темпе" : "Материалы урока"}</p><h2>${h(l.title)}</h2>${paragraphs(l.body)}${l.image_url ? `<figure>${photo(l.image_url, l.image_alt)}${l.caption ? `<figcaption>${h(l.caption)}</figcaption>` : ""}</figure>` : ""}${l.tips?.length ? `<ol class="pc-tips">${l.tips.map((t) => `<li><strong>${h(t.title)}</strong>${paragraphs(t.body)}</li>`).join("")}</ol>` : ""}${l.quote ? `<blockquote>${h(l.quote)}</blockquote>` : ""}${l.transcript ? `<details><summary>Расшифровка</summary>${paragraphs(l.transcript)}</details>` : ""}${resourceURL(l.attachment_url) ? `<a class="pc-button pc-secondary" href="${h(resourceURL(l.attachment_url))}" target="_blank" rel="noopener noreferrer">${h(l.attachment_label || "Открыть материал")} ↗</a>` : ""}</article>`;
  }
  async function player(courseId, lessonId) {
    const token = generation,
      response = await ctx.api(`/courses/${courseId}`);
    if (!valid(token)) return;
    current = { type: "player", item: response.item, lessonId };
    paintPlayer();
  }
  function paintPlayer() {
    const c = current.item,
      d = c.document,
      p = c.progress;
    const l =
      d.lessons.find((x) => x.id === current.lessonId) ||
      d.lessons.find((x) => x.id === p.last_lesson_id && !x.locked) ||
      d.lessons[0];
    current.lessonId = l?.id;
    const index = d.lessons.findIndex((x) => x.id === l?.id),
      previous = d.lessons[index - 1];
    const enrollment =
      !c.preview && !c.archived_at && !p.enrolled
        ? notice("Запишитесь на курс, чтобы сохранять свой прогресс.") +
          button("Записаться на курс", "enroll", `data-course-id="${c.id}"`)
        : "";
    const program = `<aside class="pc-aside pc-card pc-card-pad pc-program"><details open><summary>Программа курса <span>${p.percent}%</span></summary>${bar(p.percent)}<nav aria-label="Уроки курса">${d.lessons.map((x, i) => `<a class="pc-program-row${x.id === l?.id ? " is-current" : ""}${x.locked ? " is-locked" : ""}" href="${courseURL(c.id, x.id)}" ${x.id === l?.id ? 'aria-current="step"' : ""}><span class="pc-number">${p.lessons.find((a) => a.id === x.id)?.completed ? "✓" : i + 1}</span><span><strong>${h(x.title || "Без названия")}</strong><small>${kind[x.type]} · ${x.minutes} минут${x.locked ? " · недоступен" : ""}</small></span></a>`).join("")}</nav><div class="pc-note"><strong>${d.order === "free" ? "Можно проходить в своём темпе" : "Проходите уроки по порядку"}</strong><p>Прогресс сохраняется после вашей отметки изучения или успешного теста.</p></div></details></aside>`;
    let material = "";
    if (!l) material = notice("Организатор ещё не добавил материалы курса.");
    else if (l.locked)
      material = notice(
        p.finished && !d.keep_access
          ? "Курс завершён. Доступ к материалам закрыт настройками курса."
          : "Сначала завершите предыдущие уроки.",
      );
    else if (l.type === "quiz") material = quiz(c, l);
    else
      material = `${l.type === "video" ? (resourceURL(l.media_url) ? `<div class="pc-video"><video controls preload="metadata" playsinline ${imageURL(l.image_url || d.cover_url) ? `poster="${h(l.image_url || d.cover_url)}"` : ""} src="${h(resourceURL(l.media_url))}">${resourceURL(l.captions_url) ? `<track kind="captions" label="Русские субтитры" srclang="ru" src="${h(resourceURL(l.captions_url))}">` : ""}Ваш браузер не поддерживает видео.</video><p class="pc-video-error" role="alert" hidden>Видео недоступно. Текст урока остаётся доступен; попробуйте открыть видео позже.</p></div>` : notice("Видео ещё не предоставлено организатором.")) : ""}${article(l)}`;
    const complete =
      l && !l.locked && l.type !== "quiz" && !c.preview && p.enrolled
        ? button(
            l.type === "video" ? "Изучено · дальше →" : "Прочитано · дальше →",
            "complete",
          )
        : "";
    mount(
      `<a class="pc-back" href="#training">← Все курсы</a>${c.preview ? `<div class="pc-preview">Предпросмотр · прогресс не сохраняется${canEdit(ctx.user) ? `<a href="${editorURL(c.id)}">Вернуться к редактированию</a>` : ""}</div>` : ""}${c.archived_at ? notice(c.preview ? "Курс удалён из общего каталога. Материалы и прогресс участников сохранены." : "Курс удалён из общего каталога. Ваша запись и прогресс сохранены. Доступ к материалам определяется настройками курса.") : ""}${canEdit(ctx.user) ? `<div class="pc-record-actions">${courseArchiveButton(c)}</div>` : ""}<header class="pc-player-heading"><p>${h(d.title)} <span class="pc-chip">${d.required ? "Обязательный" : "По желанию"}</span></p><h1>${h(l?.title || d.title)}</h1>${l ? `<p class="pc-small">Урок ${index + 1} из ${d.lessons.length} · ${kind[l.type]} · ${l.minutes} минут</p>` : ""}</header>${enrollment}<div class="pc-columns pc-player-columns"><div class="pc-lesson-main"><div class="pc-scroll pc-material" tabindex="0" role="region" aria-label="Материал урока">${material}</div><div class="pc-player-actions">${previous ? link(l?.type === "quiz" ? "Вернуться к материалу" : "Предыдущий урок", courseURL(c.id, previous.id), true) : link("К обучению", "#training", true)}${complete}</div></div>${program}</div>`,
      "pc-player",
    );
    fitColumns(".pc-player-columns", ".pc-scroll", ".pc-aside", 100);
    if (!l || l.locked) return;
    if (p.enrolled && !c.preview)
      ctx
        .write(`/courses/${c.id}/lessons/${l.id}/visit`, {
          revision: l.revision,
        })
        .catch(error);
    const video = root.querySelector("video");
    if (video) {
      const saved = p.lessons.find((a) => a.id === l.id)?.position_seconds || 0;
      listen(video, "loadedmetadata", () => {
        if (saved && Number.isFinite(video.duration))
          video.currentTime = Math.min(saved, Math.max(0, video.duration - 1));
      });
      listen(video, "error", () => {
        root.querySelector(".pc-video-error").hidden = false;
      });
      let lastSaved = 0;
      const savePosition = () => {
        if (!p.enrolled || c.preview || Date.now() - lastSaved < 10000) return;
        lastSaved = Date.now();
        ctx
          .write(`/courses/${c.id}/lessons/${l.id}/position`, {
            revision: l.revision,
            seconds: Math.floor(video.currentTime || 0),
          })
          .catch(error);
      };
      listen(video, "pause", savePosition);
      listen(video, "timeupdate", savePosition);
    }
    const quizForm = root.querySelector("[data-pc-quiz]");
    if (quizForm) {
      const submit = quizForm.querySelector('[type="submit"]');
      listen(quizForm, "change", () => {
        submit.disabled = l.questions.some(
          (q) => !quizForm.querySelector(`input[name="q-${q.id}"]:checked`),
        );
      });
      listen(quizForm, "submit", async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const key = quizKey(c, l);
          let a = attempts.get(key);
          if (!a) {
            const r = await interact(
              `/courses/${c.id}/lessons/${l.id}/quiz-start`,
              { revision: l.revision },
            );
            a = r.attempt;
            attempts.set(key, a);
          }
          const data = new FormData(quizForm);
          const r = await interact(
            `/courses/${c.id}/lessons/${l.id}/quiz-submit`,
            {
              revision: l.revision,
              attempt_id: a.id,
              answers: l.questions.map((q) => ({
                question_id: q.id,
                option_id: data.get(`q-${q.id}`),
              })),
            },
          );
          results.set(key, r.result);
          attempts.delete(key);
          current.item = r.item;
          repaintPlayer();
          root.querySelector(".pc-quiz-result")?.focus({ preventScroll: true });
        } catch (err) {
          error(err);
          submit.disabled = false;
        }
      });
    }
  }
  function repaintPlayer() {
    controller.abort();
    controller = new AbortController();
    resizeObserver?.disconnect();
    paintPlayer();
  }
  function quiz(c, l) {
    if (c.preview)
      return `<section class="pc-card pc-article"><p class="pc-eyebrow">Предпросмотр теста</p>${l.questions.map((q) => `<h2>${h(q.prompt || "Вопрос ещё не заполнен")}</h2>${q.options.map((o) => `<div class="pc-answer">${h(o.text)}</div>`).join("")}`).join("")}${notice("Проверка ответов и сохранение прохождения доступны волонтёру после записи на опубликованный курс.")}</section>`;
    if (!c.progress.enrolled)
      return notice("Сначала запишитесь на курс, чтобы пройти тест.");
    const key = quizKey(c, l),
      result = results.get(key),
      a = attempts.get(key);
    if (result)
      return `<section class="pc-card pc-article pc-quiz-result" tabindex="-1"><p class="pc-eyebrow">Результат сохранён</p><h2>${result.expired ? "Время попытки закончилось" : result.passed ? "Тест пройден" : "Пока не совсем. Попробуйте ещё раз"}</h2><p>${result.score} из ${result.total}</p>${result.feedback.map((f) => `<div class="pc-note"><strong>${f.correct ? "Верно" : "Проверьте ответ"}</strong>${paragraphs(f.explanation)}</div>`).join("")}${result.passed ? (c.progress.finished ? `<h3>Курс завершён</h3>${paragraphs(c.document.result_message)}${link("К материалам курса", courseURL(c.id, c.document.lessons[0]?.id), true)}${link("Все курсы", "#training")}` : `${notice("Тест пройден. Чтобы завершить курс, изучите остальные материалы и отметьте их прохождение.")}${link("К непройденным материалам", courseURL(c.id, c.progress.lessons.find((x) => !x.completed)?.id))}`) : button("Попробовать ещё раз", "quiz-retry")}</section>`;
    if (!a && (l.time_limit_minutes || l.attempt_limit))
      return `<section class="pc-card pc-article"><h2>Проверим себя</h2><p>${l.questions.length} вопросов · для прохождения нужно верных ответов: ${l.pass_count}.</p><p>${l.attempt_limit ? `Попыток: ${l.attempt_limit}. Использовано: ${c.progress.lessons.find((x) => x.id === l.id)?.attempts || 0}.` : "Повторные попытки без ограничений."}${l.time_limit_minutes ? ` На попытку: ${l.time_limit_minutes} минут.` : " Без таймера."}</p>${button("Начать тест", "quiz-start")}</section>`;
    return `<form class="pc-card pc-article" data-pc-quiz><p class="pc-eyebrow">Проверим себя</p>${a?.timed ? notice(`Отправьте ответы до ${new Date(a.expires_at).toLocaleTimeString("ru-RU")}.`) : ""}${l.questions.map((q, i) => `<fieldset class="pc-question"><legend><span class="pc-small">Вопрос ${i + 1} из ${l.questions.length}</span><strong>${h(q.prompt)}</strong></legend><p>Выберите один ответ.</p>${q.options.map((o) => `<label class="pc-answer"><input type="radio" name="q-${q.id}" value="${o.id}" required><span>${h(o.text)}</span></label>`).join("")}</fieldset>`).join("")}<button class="pc-button" type="submit" disabled>Проверить ${l.questions.length === 1 ? "ответ" : "ответы"}</button><p class="pc-small">${l.attempt_limit ? `До ${l.attempt_limit} попыток` : "Повторные попытки без ограничений"}${l.time_limit_minutes ? ` · ${l.time_limit_minutes} минут на попытку` : " · без таймера"}</p></form>`;
  }
  async function legacyMaterial(id) {
    const token = generation,
      { item } = await ctx.api(`/training/${id}`);
    if (!valid(token)) return;
    current = { type: "legacy", item };
    mount(
      `<a class="pc-back" href="#training">← Все курсы</a><header class="pc-heading"><h1>${h(item.title)}</h1></header><article class="pc-card pc-article">${paragraphs(item.description)}${resourceURL(item.url) || /^http:\/\//.test(item.url || "") ? `<a class="pc-button pc-secondary" href="${h(item.url)}" target="_blank" rel="noopener noreferrer">Открыть материал ↗</a>` : ""}${item.completed ? notice("Вы отметили этот материал как пройденный.") : !isStaff(ctx.user) ? button("Материал изучен", "legacy-complete") : notice("Просмотр сотрудником не записывает прохождение.")}</article>`,
    );
  }
  async function extraCatalog(kind, page = 1) {
    const token = generation;
    const data = await ctx.api(
      kind === "legacy"
        ? `/training?page_size=50&page=${page}`
        : `/courses?type=required&page=${page}`,
    );
    if (!valid(token)) return;
    current = { type: "catalog", extraKind: kind };
    mount(
      `<a class="pc-back" href="#training">← К обучению</a><header class="pc-heading"><h1>${kind === "legacy" ? "Все отдельные материалы" : "Все обязательные курсы"}</h1></header><div class="pc-results">${kind === "legacy" ? `<section class="pc-card pc-card-pad">${legacyRows(data.items) || "Материалов пока нет"}</section>` : data.items.map((c) => card(c)).join("")}${pager(data)}</div>`,
    );
  }
  function blankDocument() {
    return {
      title: "",
      description: "",
      outcomes: "",
      topic: "",
      author: "",
      cover_url: "",
      cover_alt: "",
      required: false,
      audience: "all",
      order: "free",
      keep_access: true,
      starts_at: null,
      ends_at: null,
      result_message: "",
      lessons: [],
    };
  }
  function blankLesson(type = "text") {
    return {
      id: uuid(),
      title: "",
      type,
      minutes: 0,
      body: "",
      media_url: "",
      image_url: "",
      image_alt: "",
      caption: "",
      quote: "",
      tips: [],
      attachment_url: "",
      attachment_label: "",
      transcript: "",
      captions_url: "",
      questions: [],
      pass_count: 1,
      attempt_limit: null,
      time_limit_minutes: null,
    };
  }
  const blankQuestion = () => ({
    id: uuid(),
    prompt: "",
    options: [
      { id: uuid(), text: "" },
      { id: uuid(), text: "" },
    ],
    correct_option_id: null,
    explanation: "",
  });
  const audiences = [
    ["all", "Все волонтёры"],
    ["new", "Новые волонтёры"],
    ["active", "Активные волонтёры"],
  ];
  const getPath = (obj, path) =>
    path.split(".").reduce((v, key) => v?.[key], obj);
  function setPath(obj, path, value) {
    const keys = path.split("."),
      last = keys.pop();
    keys.reduce((v, key) => v[key], obj)[last] = value;
  }
  function field(label, path, value, opts = {}) {
    const attr = `data-pc-path="${path}" ${opts.required ? "required" : ""}`;
    return `<label class="pc-field"><span>${h(label)}</span>${opts.select ? `<select ${attr} ${opts.coerce ? `data-coerce="${opts.coerce}"` : ""}>${options(opts.select, value)}</select>` : opts.textarea ? `<textarea ${attr} rows="${opts.rows || 4}" maxlength="${opts.max || 4000}">${h(value)}</textarea>` : `<input ${attr} type="${opts.type || "text"}" value="${h(value)}" ${opts.type === "number" ? `min="${opts.min ?? 0}" max="${opts.max || 10000}" step="1"` : `maxlength="${opts.max || 200}"`} ${opts.placeholder ? `placeholder="${h(opts.placeholder)}"` : ""}>`}</label>`;
  }
  function dateField(label, path, value) {
    let local = "";
    if (value) {
      const d = new Date(value);
      if (Number.isFinite(d.getTime()))
        local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
    }
    return field(label, path, local, { type: "datetime-local" });
  }
  function uploadBox(path, value, alt = "") {
    return `<div class="pc-upload">${photo(value, alt, "pc-editor-photo")}<label class="pc-button pc-secondary">${value ? "Заменить фото" : "Выбрать файл"}<input class="pc-file-input" type="file" accept="image/jpeg,image/png" data-pc-image="${path}"></label><p class="pc-small">JPG или PNG · до 10 МБ · горизонтальное фото</p><span class="pc-upload-status" aria-live="polite"></span></div>`;
  }
  async function newCourse() {
    if (!canEdit(ctx.user)) {
      mount(notice("Создание курсов доступно руководителю и администратору."));
      return;
    }
    const document = blankDocument();
    current = { type: "new", document };
    mount(
      `<a class="pc-back" href="#training">← Все курсы</a><header class="pc-heading"><div><h1>Создать курс</h1><p>Начните с названия и идеи. Уроки и настройки можно добавить позже.</p></div><span class="pc-status">Новый черновик</span></header><form data-pc-new><div class="pc-columns"><section class="pc-card pc-card-pad"><h2>Основная информация</h2>${field("Название курса *", "title", "", { required: true, placeholder: "Название курса" })}${field("Краткое описание", "description", "", { textarea: true, rows: 3 })}${field(
        "Тип курса",
        "required",
        false,
        {
          select: [
            [false, "Необязательный"],
            [true, "Обязательный"],
          ],
          coerce: "boolean",
        },
      )}<p class="pc-small">Необязательный курс можно пройти в удобное время. Он не ограничивает запись на мероприятия.</p>${field("Для кого", "audience", "all", { select: audiences })}${uploadBox("cover_url", "")}${field("Описание изображения (alt)", "cover_alt", "", { max: 400 })}</section><aside class="pc-card pc-card-pad pc-aside"><h2>С чего начать</h2><p>Одна понятная цель — один небольшой курс. Подойдут видео, текст и короткая проверка.</p><hr><ol><li>Добавить описание</li><li>Собрать программу</li><li>Проверить и опубликовать</li></ol></aside></div><footer class="pc-editor-footer">${link("Отменить", "#training", true)}<button class="pc-button" type="submit">Создать черновик</button></footer></form>`,
      "pc-organizer",
    );
    bindFields(document);
    listen(root.querySelector("[data-pc-new]"), "submit", async (event) => {
      event.preventDefault();
      const b = event.target.querySelector('[type="submit"]');
      b.disabled = true;
      try {
        const { item } = await interact("/courses", { document });
        location.hash = editorURL(item.id);
      } catch (e) {
        error(e);
        b.disabled = false;
      }
    });
  }
  async function editCourse(courseId, tab = "description") {
    if (!canEdit(ctx.user)) {
      mount(
        notice("Редактирование курсов доступно руководителю и администратору."),
      );
      return;
    }
    const token = generation,
      key = `${ctx.user.id}:${courseId}`;
    let draft = drafts.get(key);
    if (!draft || (!draft.dirty && !draft.saving)) {
      const { item } = await ctx.api(`/courses/${courseId}/editor`);
      if (!valid(token)) return;
      draft = {
        item,
        document: clone(item.document),
        dirty: false,
        serial: 0,
        saving: null,
        ctx,
        key,
      };
      drafts.set(key, draft);
    }
    current = {
      type: "editor",
      draft,
      tab: steps.some(([x]) => x === tab) ? tab : "description",
    };
    paintEditor();
  }
  function dirty(draft) {
    draft.dirty = true;
    draft.serial++;
    draft.error = null;
    updateSaveStatus(draft, "Изменения ещё не сохранены");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush(draft).catch(() => {}), 800);
  }
  function updateSaveStatus(draft, message) {
    if (current?.draft !== draft || !root?.isConnected) return;
    const el = root.querySelector("[data-pc-save-status]");
    if (el) el.textContent = message;
    const retry = root.querySelector('[data-pc-action="save"]');
    if (retry) retry.hidden = !draft.error;
  }
  async function flush(draft = current?.draft) {
    clearTimeout(saveTimer);
    // reset() removes drafts on logout; a late save may finish but must not enqueue another.
    if (!draft || drafts.get(draft.key) !== draft) return;
    if (draft.saving) {
      await draft.saving;
      if (draft.dirty) return flush(draft);
      return;
    }
    if (!draft.dirty) return;
    const serial = draft.serial,
      snapshot = clone(draft.document),
      apiContext = draft.ctx;
    updateSaveStatus(draft, "Сохраняем…");
    draft.saving = apiContext
      .write(
        `/courses/${draft.item.id}`,
        { document: snapshot, expected_version: draft.item.version },
        "PATCH",
      )
      .then(({ item }) => {
        draft.item = item;
        draft.error = null;
        if (serial === draft.serial) {
          draft.document = clone(item.document);
          draft.dirty = false;
          updateSaveStatus(draft, "Все изменения сохранены");
        }
      })
      .catch((e) => {
        draft.error = e;
        updateSaveStatus(draft, "Не удалось сохранить · Повторить");
        throw e;
      })
      .finally(() => {
        draft.saving = null;
      });
    await draft.saving;
    if (draft.dirty) return flush(draft);
  }
  function bindFields(document, draft) {
    const update = (event) => {
      const input = event.target.closest("[data-pc-path]");
      if (!input) return;
      let value = input.value;
      if (input.dataset.coerce === "boolean") value = value === "true";
      else if (input.type === "number")
        value = value === "" && input.dataset.nullable ? null : Number(value);
      else if (input.type === "datetime-local") {
        if (value && !Number.isFinite(new Date(value).getTime())) return;
        value = value ? new Date(value).toISOString() : null;
      } else if (input.type === "checkbox") value = input.checked;
      // Always update the current draft object: normalization can replace it after saving.
      setPath(draft ? draft.document : document, input.dataset.pcPath, value);
      if (draft) dirty(draft);
    };
    listen(root, "input", update);
    listen(root, "change", (e) => {
      if (
        e.target.tagName === "SELECT" ||
        e.target.type === "radio" ||
        e.target.type === "checkbox"
      )
        update(e);
      if (draft && /^lessons\.\d+\.type$/.test(e.target.dataset.pcPath || ""))
        repaintEditor();
    });
    listen(root, "change", async (event) => {
      const input = event.target.closest("[data-pc-image]");
      if (!input || !input.files[0]) return;
      const token = generation;
      const file = input.files[0],
        box = input.closest(".pc-upload"),
        message = box.querySelector(".pc-upload-status");
      if (
        !["image/jpeg", "image/png"].includes(file.type) ||
        file.size > 10 * 1024 * 1024
      ) {
        message.textContent = "Выберите JPG или PNG размером до 10 МБ.";
        input.value = "";
        return;
      }
      input.disabled = true;
      message.textContent = "Загружаем…";
      try {
        const result = await ctx.api("/uploads/images", {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        // A delayed upload must not mutate an editor that has been closed or replaced.
        if (!valid(token) || !input.isConnected) return;
        if (!imageURL(result.url))
          throw new Error("Сервер не вернул адрес изображения.");
        setPath(
          draft ? draft.document : document,
          input.dataset.pcImage,
          result.url,
        );
        let img = box.querySelector("img");
        if (!img) {
          img = window.document.createElement("img");
          img.className = "pc-editor-photo";
          img.alt = "Предпросмотр загруженного изображения";
          box.prepend(img);
        }
        img.src = result.url;
        message.textContent = "Изображение загружено";
        if (draft) dirty(draft);
      } catch (e) {
        message.textContent = e.message;
      } finally {
        input.disabled = false;
        input.value = "";
      }
    });
  }
  function paintEditor() {
    const e = current.draft,
      c = e.item,
      d = e.document,
      tab = current.tab;
    if (c.archived_at) {
      mount(
        `<a class="pc-back" href="#training">← Все курсы</a><header class="pc-heading"><div><h1>${h(d.title)}</h1>${status(c)}</div>${courseArchiveButton(c)}</header>${notice("Курс находится в корзине. Материалы, записи и прогресс участников сохранены. Для редактирования восстановите курс; ему вернётся прежний статус публикации.")}<section class="pc-card pc-card-pad"><h2>Описание курса</h2>${paragraphs(d.description)}${link("Открыть материалы", courseURL(c.id), true)}</section>`,
        "pc-organizer",
      );
      return;
    }
    const totalMinutes = d.lessons.reduce((sum, l) => sum + l.minutes, 0);
    let content;
    if (tab === "description")
      content = `<div class="pc-columns"><section class="pc-card pc-card-pad"><h2>Описание курса</h2>${field("Название курса *", "title", d.title, { required: true })}${field("Краткое описание *", "description", d.description, { textarea: true })}${field("Чему научится волонтёр", "outcomes", d.outcomes, { textarea: true, rows: 3 })}<div class="pc-field-grid">${field(
        "Тип курса",
        "required",
        d.required,
        {
          select: [
            [false, "Необязательный"],
            [true, "Обязательный"],
          ],
          coerce: "boolean",
        },
      )}${field("Аудитория", "audience", d.audience, { select: audiences })}</div>${field("Тема", "topic", d.topic, { max: 100 })}${field("Автор / координатор", "author", d.author)}</section><aside class="pc-card pc-card-pad"><h2>Обложка курса</h2>${uploadBox("cover_url", d.cover_url, d.cover_alt)}${field("Описание изображения (alt)", "cover_alt", d.cover_alt, { textarea: true, rows: 3, max: 400 })}${status(c)}<p class="pc-small">${c.status === "draft" ? "Курс видит только команда. Волонтёры увидят его после публикации." : "Изменения опубликованного материала применятся после сохранения. Изменённые уроки потребуется пройти заново."}</p></aside></div>`;
    else if (tab === "program") content = programEditor(d);
    else if (tab === "quiz") content = quizEditor(d);
    else content = accessEditor(e);
    const stepIndex = steps.findIndex(([x]) => x === tab);
    mount(
      `<div class="pc-editor-top"><a class="pc-back" href="#training">← Все курсы</a>${status(c)}<span class="pc-small pc-save-status" data-pc-save-status role="status">${e.error ? "Не удалось сохранить · Повторить" : e.dirty ? "Изменения ещё не сохранены" : "Все изменения сохранены"}</span>${button("Повторить", "save", e.error ? "" : "hidden", true)}${link("Предпросмотр", courseURL(c.id), true)}${courseArchiveButton(c)}</div><header class="pc-editor-heading"><h1>${h(d.title || "Название курса")}</h1><p>${d.lessons.length} уроков · ${totalMinutes} минут · ${d.required ? "обязательное" : "необязательное"} обучение</p></header><nav class="pc-tabs" aria-label="Редактирование курса">${steps.map(([key, label]) => `<a class="pc-chip${key === tab ? " is-active" : ""}" href="${editorURL(c.id, key)}" ${key === tab ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>${content}<footer class="pc-editor-footer">${link(stepIndex ? `Назад: ${steps[stepIndex - 1][1].toLowerCase()}` : "К списку курсов", stepIndex ? editorURL(c.id, steps[stepIndex - 1][0]) : "#training", true)}${stepIndex < 3 ? link(`Далее: ${steps[stepIndex + 1][1].toLowerCase()}`, editorURL(c.id, steps[stepIndex + 1][0])) : button("Сохранить и выйти", "save-exit", "", true)}</footer>`,
      "pc-organizer pc-editor",
    );
    bindFields(d, e);
    window.PortalUI?.setGuard(() => {
      if (!root?.isConnected || (!e.dirty && !e.saving)) return false;
      // Switching editor tabs keeps the same in-memory draft and may continue
      // autosaving; browser Back to another section gets the shared guard.
      const target = location.hash;
      return (
        target !== `#training/edit/${c.id}` &&
        !target.startsWith(`#training/edit/${c.id}/`)
      );
    });
    if (e.dirty && !e.error && !e.saving) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(e).catch(() => {}), 800);
    }
    listen(
      document,
      "click",
      (event) => {
        const anchor = event.target.closest('a[href^="#"]');
        if (
          !anchor ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          (!e.dirty && !e.saving)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const token = generation;
        flush(e)
          .then(() => {
            if (valid(token)) location.hash = anchor.getAttribute("href");
          })
          .catch(error);
      },
      { capture: true },
    );
    listen(window, "beforeunload", (event) => {
      if (e.dirty || e.saving) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    if (tab === "program") {
      fitColumns(
        ".pc-program-editor",
        ".pc-editor-materials",
        ".pc-program-list",
        24,
      );
      let dragged;
      listen(root, "dragstart", (event) => {
        const row = event.target.closest("[data-lesson-order]");
        if (row) {
          dragged = Number(row.dataset.lessonOrder);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(dragged));
        }
      });
      listen(root, "dragover", (event) => {
        if (
          dragged !== undefined &&
          event.target.closest("[data-lesson-order]")
        )
          event.preventDefault();
      });
      listen(root, "drop", (event) => {
        const row = event.target.closest("[data-lesson-order]");
        if (!row || dragged === undefined) return;
        event.preventDefault();
        const to = Number(row.dataset.lessonOrder);
        reorderLesson(dragged, to);
        dragged = undefined;
      });
      listen(root, "dragend", () => {
        dragged = undefined;
      });
    }
  }
  function programEditor(d) {
    return `<div class="pc-program-editor"><aside class="pc-program-list pc-card pc-card-pad"><h2>Программа</h2><p class="pc-small">${d.lessons.length} уроков</p>${d.lessons.map((l, i) => `<div class="pc-order-row" draggable="true" data-lesson-order="${i}"><button type="button" class="pc-program-row" data-pc-action="lesson-anchor" data-lesson-id="${l.id}"><strong>${i + 1}. ${h(l.title || "Новый урок")}</strong><small>${kind[l.type]} · ${l.minutes} минут</small></button><div class="pc-order-actions">${button("↑", "lesson-up", `data-index="${i}" aria-label="Поднять урок ${i + 1}" ${i === 0 ? "disabled" : ""}`, true)}${button("↓", "lesson-down", `data-index="${i}" aria-label="Опустить урок ${i + 1}" ${i === d.lessons.length - 1 ? "disabled" : ""}`, true)}</div></div>`).join("")}${button("+ Добавить урок", "add-lesson", "", true)}<hr><p class="pc-small">Перетащите строку или используйте стрелки, чтобы изменить порядок.</p></aside><div class="pc-editor-materials">${
      d.lessons
        .map(
          (l, i) =>
            `<section class="pc-card pc-card-pad" id="pc-edit-lesson-${l.id}"><div class="pc-inline"><h2>${h(l.title || "Новый урок")}</h2>${button("Удалить урок", "remove-lesson", `data-index="${i}"`, true)}</div><div class="pc-field-grid">${field(
              "Тип урока",
              `lessons.${i}.type`,
              l.type,
              {
                select: [
                  ["video", "Видео"],
                  ["text", "Текст"],
                  ["quiz", "Тест"],
                ],
              },
            )}${field("Длительность, минут", `lessons.${i}.minutes`, l.minutes, { type: "number" })}</div>${field("Название урока", `lessons.${i}.title`, l.title)}${l.type === "quiz" ? `<p>Вопросы и условие прохождения настраиваются отдельно.</p>${link("Открыть редактор теста", editorURL(current.draft.item.id, "quiz"), true)}` : `${l.type === "video" ? `${field("Адрес видео (HTTPS)", `lessons.${i}.media_url`, l.media_url, { max: 2000, placeholder: "https://…/lesson.mp4" })}<p class="pc-small">Ссылка должна вести на настоящий видеофайл. Загрузка видео на сайт сейчас не предусмотрена.</p>` : ""}${uploadBox(`lessons.${i}.image_url`, l.image_url, l.image_alt)}${field("Описание фотографии", `lessons.${i}.image_alt`, l.image_alt, { max: 400 })}${field("Подпись под фотографией", `lessons.${i}.caption`, l.caption, { max: 1000 })}${field(l.type === "video" ? "Текст под видео" : "Содержание урока", `lessons.${i}.body`, l.body, { textarea: true, rows: 9, max: 30000 })}${field("Выделенная цитата / главное", `lessons.${i}.quote`, l.quote, { textarea: true, rows: 2, max: 2000 })}${l.tips.map((tip, t) => `<div class="pc-note">${field(`Ориентир ${t + 1}`, `lessons.${i}.tips.${t}.title`, tip.title)}${field("Пояснение", `lessons.${i}.tips.${t}.body`, tip.body, { textarea: true, max: 2000 })}${button("Удалить ориентир", "remove-tip", `data-index="${i}" data-tip="${t}"`, true)}</div>`).join("")}${button("+ Добавить ориентир", "add-tip", `data-index="${i}"`, true)}<div class="pc-field-grid">${field("Ссылка на памятку / вложение", `lessons.${i}.attachment_url`, l.attachment_url, { max: 2000 })}${field("Название вложения", `lessons.${i}.attachment_label`, l.attachment_label)}</div>${l.type === "video" ? `${field("Субтитры — адрес VTT (при наличии)", `lessons.${i}.captions_url`, l.captions_url, { max: 2000 })}${field("Расшифровка (при наличии)", `lessons.${i}.transcript`, l.transcript, { textarea: true, max: 20000 })}` : ""}`}</section>`,
        )
        .join("") ||
      notice(
        "Добавьте первый урок. Содержимое и видео предоставляет организатор.",
      )
    }</div></div>`;
  }
  function quizEditor(d) {
    const quizzes = d.lessons
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.type === "quiz");
    if (!quizzes.length)
      return `<section class="pc-card pc-card-pad"><h2>Тест курса</h2><p>Добавьте тест, затем заполните вопросы и варианты ответов.</p>${button("+ Добавить тест", "add-quiz")}</section>`;
    return quizzes
      .map(
        ({ l, i }) =>
          `<div class="pc-columns pc-quiz-editor"><section class="pc-card pc-card-pad"><h2>${h(l.title || "Тест курса")}</h2>${l.questions.map((q, j) => `<section class="pc-edit-question"><div class="pc-inline"><h3>Вопрос ${j + 1} из ${l.questions.length}</h3>${button("Удалить", "remove-question", `data-index="${i}" data-question="${j}"`, true)}</div><p class="pc-small">Один правильный ответ</p>${field("Вопрос *", `lessons.${i}.questions.${j}.prompt`, q.prompt, { textarea: true, rows: 2, max: 2000 })}<span class="pc-small">Варианты ответа · отметьте правильный</span>${q.options.map((o, k) => `<div class="pc-edit-answer"><input type="radio" name="correct-${q.id}" value="${o.id}" data-pc-path="lessons.${i}.questions.${j}.correct_option_id" ${q.correct_option_id === o.id ? "checked" : ""} aria-label="Вариант ${k + 1} правильный"><input type="text" value="${h(o.text)}" data-pc-path="lessons.${i}.questions.${j}.options.${k}.text" maxlength="1000" aria-label="Текст варианта ${k + 1}">${button("×", "remove-option", `data-index="${i}" data-question="${j}" data-option="${k}" aria-label="Удалить вариант ${k + 1}" ${q.options.length <= 2 ? "disabled" : ""}`, true)}</div>`).join("")}${button("+ Добавить вариант", "add-option", `data-index="${i}" data-question="${j}" ${q.options.length >= 8 ? "disabled" : ""}`, true)}${field("Пояснение после ответа", `lessons.${i}.questions.${j}.explanation`, q.explanation, { textarea: true })}${button("Дублировать вопрос", "duplicate-question", `data-index="${i}" data-question="${j}"`, true)}</section>`).join("")}${button("+ Добавить вопрос", "add-question", `data-index="${i}" ${l.questions.length >= 30 ? "disabled" : ""}`, true)}</section><aside class="pc-card pc-card-pad"><h2>Настройки теста</h2>${field("Верных ответов для прохождения", `lessons.${i}.pass_count`, l.pass_count, { type: "number", min: 1, max: 30 })}<p class="pc-small">Всего вопросов: ${l.questions.length}. Для одного вопроса укажите 1.</p><label class="pc-field"><span>Число попыток</span><input type="number" min="1" max="100" data-nullable="true" data-pc-path="lessons.${i}.attempt_limit" value="${l.attempt_limit || ""}" placeholder="Без ограничений"></label><label class="pc-field"><span>Время на попытку, минут</span><input type="number" min="1" max="180" data-nullable="true" data-pc-path="lessons.${i}.time_limit_minutes" value="${l.time_limit_minutes || ""}" placeholder="Без таймера"></label><hr><h3>После ответа</h3><p>Показываются результат и пояснение. Успешный тест завершает только этот урок, остальные материалы отмечаются отдельно.</p></aside></div>`,
      )
      .join("");
  }
  function accessEditor(e) {
    const d = e.document,
      issues = e.item.publication_issues || [];
    return `<div class="pc-columns"><section class="pc-card pc-card-pad"><h2>Доступ и прохождение</h2>${field("Кому доступен курс", "audience", d.audience, { select: audiences })}${field(
      "Порядок уроков",
      "order",
      d.order,
      {
        select: [
          ["free", "В любом порядке"],
          ["sequential", "Последовательно"],
        ],
      },
    )}<hr><h2>Когда курс считается завершённым</h2><p>Все ${d.lessons.length} уроков отмечены как пройденные. Каждый тест должен быть успешно сдан.</p>${field(
      "Доступ после завершения",
      "keep_access",
      d.keep_access,
      {
        select: [
          [true, "Материалы остаются доступны"],
          [false, "Материалы закрываются"],
        ],
        coerce: "boolean",
      },
    )}${field("Сообщение после завершения", "result_message", d.result_message, { textarea: true, max: 2000 })}<div class="pc-field-grid">${dateField("Начало доступа (пусто — сразу)", "starts_at", d.starts_at)}${dateField("Окончание (пусто — без срока)", "ends_at", d.ends_at)}</div></section><aside class="pc-card pc-card-pad"><h2>${issues.length ? "Проверьте перед публикацией" : "Готов к публикации"}</h2><ul class="pc-checklist">${issues.length ? issues.map((x) => `<li>${h(x)}</li>`).join("") : "<li>Название, описание и обложка добавлены</li><li>Материалы уроков заполнены</li><li>Условия тестов настроены</li>"}</ul>${link("Предпросмотр курса", courseURL(e.item.id), true)}<p class="pc-small">После публикации курс появится у выбранной аудитории в указанный срок.</p>${button(e.item.status === "published" ? "Снять с публикации" : "Опубликовать курс", "publish")}</aside></div><div class="pc-note"><strong>${d.required ? "Обязательный курс" : "Необязательный курс"}</strong><p>${d.required ? "Курс входит в обязательный маршрут обучения." : "Прохождение помогает подготовиться и не ограничивает запись на мероприятия."}</p></div>`;
  }
  function repaintEditor() {
    controller.abort();
    controller = new AbortController();
    resizeObserver?.disconnect();
    paintEditor();
  }
  function reorderLesson(from, to) {
    const e = current.draft;
    if (to < 0 || to >= e.document.lessons.length || from === to) return;
    const [l] = e.document.lessons.splice(from, 1);
    e.document.lessons.splice(to, 0, l);
    dirty(e);
    repaintEditor();
  }
  async function handleAction(action, control) {
    if (!root || control.disabled) return false;
    const token = generation;
    control.disabled = true;
    try {
      if (action === "accordion") {
        const s = state(),
          area = root.querySelector("#pc-required-materials");
        s.expanded = !s.expanded;
        try {
          localStorage.setItem(
            `course-required:${ctx.user.id}`,
            String(s.expanded),
          );
        } catch {}
        control.setAttribute("aria-expanded", String(s.expanded));
        control.querySelector(".pc-accordion-label").firstChild.textContent =
          s.expanded ? "Свернуть" : "Развернуть";
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduced) {
          area.hidden = !s.expanded;
          area.inert = !s.expanded;
        } else {
          area.hidden = false;
          const height = area.scrollHeight;
          area.inert = !s.expanded;
          const animation = area.animate(
            [
              {
                height: s.expanded ? "0px" : `${height}px`,
                opacity: s.expanded ? 0 : 1,
              },
              {
                height: s.expanded ? `${height}px` : "0px",
                opacity: s.expanded ? 1 : 0,
              },
            ],
            { duration: 220, easing: "cubic-bezier(.4,0,.2,1)" },
          );
          await animation.finished;
          area.hidden = !s.expanded;
          area.inert = !s.expanded;
        }
      } else if (action === "page") {
        if (current.extraKind)
          await extraCatalog(current.extraKind, Number(control.dataset.page));
        else {
          state().page = Number(control.dataset.page);
          await current.refresh();
        }
      } else if (action === "reset-search") {
        Object.assign(state(), {
          q: "",
          topic: "",
          status: "",
          type: "",
          sort: "newest",
          archived: "false",
          history: "false",
          page: 1,
        });
        const form = root.querySelector("[data-pc-search]");
        clearTimeout(searchTimer);
        for (const input of form.querySelectorAll("input,select"))
          input.value =
            input.name === "sort"
              ? "newest"
              : ["archived", "history"].includes(input.name)
                ? "false"
                : "";
        await current.refresh();
      } else if (action === "archive-course" || action === "restore-course") {
        const restoring = action === "restore-course";
        let c =
          current.draft?.item ||
          current.item ||
          current.data?.items.find(
            (x) => String(x.id) === control.dataset.courseId,
          );
        if (!c || !canEdit(ctx.user))
          throw new Error("Курс не найден. Откройте список заново.");
        const title =
          current.draft?.document.title || c.document?.title || c.title;
        const description = restoring
          ? `Восстановить курс «${title}»? ${c.status === "published" ? "Он снова будет опубликован для выбранной аудитории в рамках настроенного срока доступа." : "Он вернётся в черновики."} Прогресс участников сохранится.`
          : `Удалить курс «${title}»? Он исчезнет из каталога и обязательного маршрута. Материалы и прогресс участников сохранятся, уже записанные волонтёры сохранят доступ в рамках настроек курса. Курс можно восстановить из корзины.`;
        if (!window.confirm(description)) return true;
        if (current.draft) {
          await flush();
          if (!valid(token)) return true;
          c = current.draft.item;
        }
        await interact(
          `/courses/${c.id}/${restoring ? "restore" : "archive"}`,
          { expected_version: c.version },
        );
        drafts.delete(`${ctx.user.id}:${c.id}`);
        state().page = 1;
        ctx.toast?.(
          restoring ? "Курс восстановлен" : "Курс перемещён в корзину",
        );
        if (location.hash === "#training") await catalog();
        else location.hash = "#training";
      } else if (action === "enroll") {
        const id = control.dataset.courseId;
        const r = await interact(`/courses/${id}/enroll`);
        const target = courseURL(
          id,
          r.item.progress.last_lesson_id || r.item.document.lessons[0]?.id,
        );
        if (location.hash === target) {
          current.item = r.item;
          repaintPlayer();
        } else location.hash = target;
      } else if (action === "complete") {
        const c = current.item,
          l = c.document.lessons.find((x) => x.id === current.lessonId);
        const r = await interact(`/courses/${c.id}/lessons/${l.id}/complete`, {
          revision: l.revision,
        });
        current.item = r.item;
        const next =
          c.document.lessons[
            c.document.lessons.findIndex((x) => x.id === l.id) + 1
          ];
        if (next) location.hash = courseURL(c.id, next.id);
        else {
          ctx.toast?.(
            r.item.progress.finished
              ? "Курс завершён. Прогресс сохранён."
              : "Материал отмечен как изученный.",
          );
          repaintPlayer();
        }
      } else if (action === "quiz-start") {
        const c = current.item,
          l = c.document.lessons.find((x) => x.id === current.lessonId);
        const r = await interact(
          `/courses/${c.id}/lessons/${l.id}/quiz-start`,
          { revision: l.revision },
        );
        attempts.set(quizKey(c, l), r.attempt);
        current.item = r.item;
        repaintPlayer();
      } else if (action === "quiz-retry") {
        const c = current.item,
          l = c.document.lessons.find((x) => x.id === current.lessonId);
        results.delete(quizKey(c, l));
        attempts.delete(quizKey(c, l));
        repaintPlayer();
      } else if (action === "legacy-complete") {
        await interact(`/training/${current.item.id}/complete`);
        await legacyMaterial(current.item.id);
      } else if (action === "save") await flush();
      else if (action === "save-exit") {
        await flush();
        if (valid(token)) location.hash = "#training";
      } else if (action === "publish") {
        await flush();
        if (!valid(token)) return true;
        const e = current.draft;
        const { item } = await interact(`/courses/${e.item.id}/publication`, {
          expected_version: e.item.version,
          published: e.item.status !== "published",
        });
        e.item = item;
        ctx.toast?.(
          item.status === "published"
            ? "Курс опубликован"
            : "Курс сохранён как черновик",
        );
        repaintEditor();
      } else if (action === "lesson-anchor") {
        const element = root.querySelector(
          `#pc-edit-lesson-${control.dataset.lessonId}`,
        );
        element?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
        });
      } else if (action === "lesson-up" || action === "lesson-down")
        reorderLesson(
          Number(control.dataset.index),
          Number(control.dataset.index) + (action === "lesson-up" ? -1 : 1),
        );
      else if (current.type === "editor") {
        const e = current.draft,
          i = Number(control.dataset.index),
          j = Number(control.dataset.question),
          k = Number(control.dataset.option),
          l = e.document.lessons[i];
        if (action === "add-lesson" || action === "add-quiz") {
          if (e.document.lessons.length >= 50)
            throw new Error("В курсе может быть не больше 50 уроков.");
          const next = blankLesson(action === "add-quiz" ? "quiz" : "text");
          if (next.type === "quiz") next.questions.push(blankQuestion());
          e.document.lessons.push(next);
        } else if (action === "remove-lesson") {
          if (
            !window.confirm(
              "Удалить урок из программы? Прогресс остальных уроков сохранится.",
            )
          )
            return true;
          e.document.lessons.splice(i, 1);
        } else if (action === "add-tip") {
          if (l.tips.length >= 10)
            throw new Error("Можно добавить до 10 ориентиров.");
          l.tips.push({ title: "", body: "" });
        } else if (action === "remove-tip")
          l.tips.splice(Number(control.dataset.tip), 1);
        else if (action === "add-question") {
          if (l.questions.length >= 30)
            throw new Error("Можно добавить до 30 вопросов.");
          l.questions.push(blankQuestion());
        } else if (action === "remove-question") l.questions.splice(j, 1);
        else if (action === "duplicate-question") {
          if (l.questions.length >= 30)
            throw new Error("Можно добавить до 30 вопросов.");
          const q = clone(l.questions[j]),
            old = q.correct_option_id;
          q.id = uuid();
          q.options = q.options.map((o) => {
            const n = uuid();
            if (o.id === old) q.correct_option_id = n;
            return { id: n, text: o.text };
          });
          l.questions.splice(j + 1, 0, q);
        } else if (action === "add-option") {
          if (l.questions[j].options.length < 8)
            l.questions[j].options.push({ id: uuid(), text: "" });
        } else if (action === "remove-option") {
          const q = l.questions[j];
          if (q.options.length <= 2) return true;
          if (q.options[k].id === q.correct_option_id)
            q.correct_option_id = null;
          q.options.splice(k, 1);
        } else return false;
        dirty(e);
        repaintEditor();
      } else return false;
      return true;
    } finally {
      if (control.isConnected) control.disabled = false;
    }
  }
  function destroy() {
    generation++;
    clearTimeout(searchTimer);
    clearTimeout(saveTimer);
    controller?.abort();
    resizeObserver?.disconnect();
    // Dirty drafts remain in memory on browser Back/manual hash changes. Normal
    // links flush before navigation; never initiate a write during logout.
    root = null;
    current = null;
  }
  function reset() {
    destroy();
    catalogs.clear();
    drafts.clear();
    attempts.clear();
    results.clear();
    lastUser = undefined;
  }
  async function render(context) {
    destroy();
    ctx = context;
    controller = new AbortController();
    if (lastUser !== String(ctx.user.id)) {
      attempts.clear();
      results.clear();
      lastUser = String(ctx.user.id);
    }
    const token = generation,
      route = String(context.route || location.hash)
        .replace(/^#/, "")
        .split("/");
    try {
      if (route[1] === "course" && /^\d+$/.test(route[2] || ""))
        await player(route[2], route[3] === "lesson" ? route[4] : undefined);
      else if (route[1] === "edit" && /^\d+$/.test(route[2] || ""))
        await editCourse(route[2], route[3]);
      else if (route[1] === "new") await newCourse();
      else if (route[1] === "materials") await extraCatalog("legacy");
      else if (route[1] === "required") await extraCatalog("required");
      else if (route[1] === "material" && /^\d+$/.test(route[2] || ""))
        await legacyMaterial(route[2]);
      else if (/^\d+$/.test(route[1] || "")) await legacyMaterial(route[1]);
      else await catalog();
    } catch (e) {
      if (valid(token))
        mount(
          `<a class="pc-back" href="#training">← Все курсы</a>${notice(e.message, true)}`,
        );
    }
  }
  window.PortalCourses = { render, destroy, reset, handleAction, flush };
})();
