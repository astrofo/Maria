(() => {
  "use strict";
  const h = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (s) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[s],
    );
  const roles = {
    volunteer: "Волонтёр",
    coordinator: "Координатор",
    manager: "Организатор",
    admin: "Администратор",
  };
  const statuses = {
    draft: "Черновик",
    queued: "В очереди",
    sending: "Отправляется",
    sent: "Отправлено",
    cancelled: "Отменено",
  };
  const isOrganizer = (user) => ["manager", "admin"].includes(user?.role);
  const date = (value) =>
    value
      ? new Date(value).toLocaleString("ru-RU", {
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  const request = (context, path, body, method = "POST") =>
    body === undefined
      ? context.api(path)
      : context.api(path, { method, body: JSON.stringify(body) });
  const field = (label, name, value = "", extra = "") =>
    `<label class="dm-field"><span>${h(label)}</span><input name="${h(name)}" value="${h(value)}" ${extra}></label>`;
  const area = (label, name, value = "", extra = "") =>
    `<label class="dm-field"><span>${h(label)}</span><textarea name="${h(name)}" maxlength="4000" rows="3" ${extra}>${h(value)}</textarea></label>`;
  const closeButton = `<button type="button" class="dm-close" data-dm-close aria-label="Закрыть"><img src="/assets/figma/messaging-close.svg" alt="" width="24" height="24"></button>`;
  const successMark =
    '<div class="dm-success-mark"><img src="/assets/figma/messaging-success.svg" alt="" width="24" height="24"></div>';
  const tabbar = (active) =>
    `<nav class="dm-tabs" aria-label="Раздел сообщений"><a class="dm-chip" href="#groups">Общение</a><a class="dm-chip ${active === "inbox" ? "selected" : ""}" href="#messages" ${active === "inbox" ? 'aria-current="page"' : ""}>Обращения в фонд</a><a class="dm-chip ${active === "campaigns" ? "selected" : ""}" href="#campaigns" ${active === "campaigns" ? 'aria-current="page"' : ""}>Рассылки</a></nav>`;
  const badge = (text) =>
    `<span class="dm-status"><img src="/assets/figma/messaging-dot.svg" width="6" height="6" alt="">${h(text)}</span>`;
  const pageHead = (title, subtitle) =>
    `<header class="dm-heading"><h1>${h(title)}</h1><p>${h(subtitle)}</p></header>`;
  const pager = (data) =>
    `<div class="dm-pager"><button type="button" class="button secondary" data-dm-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""}>Назад</button><span>Страница ${data.page} из ${data.pages} · ${data.total}</span><button type="button" class="button secondary" data-dm-page="${data.page + 1}" ${data.page >= data.pages ? "disabled" : ""}>Далее</button></div>`;
  const errorHTML = (error) =>
    `<div class="notice error" role="alert">${h(error.message || "Не удалось выполнить действие")}</div>`;
  const reduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const drafts = new Map();
  let generation = 0,
    activeModal = null,
    overlayCount = 0,
    originalOverflow = "";
  const pageCleanups = new Set();

  function cleanPage() {
    generation++;
    for (const cleanup of pageCleanups) cleanup();
    pageCleanups.clear();
  }
  function deactivate() {
    cleanPage();
    activeModal?.close(true);
  }
  function destroy() {
    deactivate();
    drafts.clear();
  }
  function current(set, token, element) {
    return (
      token === generation &&
      (!set.current || set.current()) &&
      (!element || element.isConnected)
    );
  }
  function modal(content, { chat = false, onClose } = {}) {
    activeModal?.close(true);
    const dialog = document.createElement("dialog");
    dialog.className = chat ? "dm-dialog dm-chat-dialog" : "dm-dialog";
    dialog.setAttribute("aria-labelledby", "dm-modal-title");
    dialog.innerHTML = content;
    document.body.append(dialog);
    const viewport = window.visualViewport;
    const syncViewport = () => {
      dialog.style.setProperty(
        "--dm-viewport-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      dialog.style.setProperty(
        "--dm-viewport-top",
        `${viewport?.offsetTop || 0}px`,
      );
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    const focus = document.activeElement;
    if (!overlayCount) originalOverflow = document.body.style.overflow;
    overlayCount++;
    document.body.style.overflow = "hidden";
    let closed = false,
      completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      dialog.close();
      dialog.remove();
      overlayCount--;
      if (!overlayCount) {
        document.body.style.overflow = originalOverflow;
        if (focus?.isConnected) focus.focus({ preventScroll: true });
      }
    };
    const instance = {
      dialog,
      close(immediate = false) {
        if (closed) {
          if (immediate) complete();
          return;
        }
        closed = true;
        onClose?.();
        if (activeModal === instance) activeModal = null;
        if (immediate || reduced()) complete();
        else {
          dialog.classList.add("dm-closing");
          setTimeout(complete, chat ? 140 : 120);
        }
      },
      alive: () => !closed && dialog.isConnected,
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      instance.close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-dm-close]")) instance.close();
      if (event.target === dialog) {
        const bounds = dialog.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          instance.close();
      }
    });
    dialog.showModal();
    activeModal = instance;
    return instance;
  }
  function messageHTML(item, staffView) {
    const outgoing = staffView
      ? item.sender_kind === "organizer"
      : item.sender_kind !== "organizer";
    return `<div class="dm-message-row ${outgoing ? "outgoing" : ""}"><article class="dm-bubble"><div class="dm-author">${outgoing ? "Вы" : h(item.sender_name)}${item.sender_kind === "organizer" ? " · организатор" : ""}</div><p>${h(item.body)}</p><div class="dm-caption">${h(date(item.created_at))} · ${outgoing ? (item.read ? "Прочитано" : "Отправлено") : "Получено"}</div></article></div>`;
  }

  // Own and organizer conversations share one history/composer. Messages are
  // appended only after the server acknowledges persistence; retries reuse UUID.
  function conversation(
    element,
    context,
    {
      initial,
      staffView = false,
      alive = () => element.isConnected,
      eventId,
      draftKey,
    },
  ) {
    let data = initial,
      items = initial.items || [],
      pending = false,
      loading = false,
      readId = 0,
      reading = false;
    let stopped = false,
      serverCursor = Number(items.at(-1)?.id) || 0,
      catchupPending = false;
    // Sending a message is not proof that all earlier incoming messages were fetched.
    const merge = (incoming) => {
      const byId = new Map(items.map((item) => [String(item.id), item]));
      for (const item of incoming) byId.set(String(item.id), item);
      items = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
    };
    const draft = drafts.get(draftKey) || {
      body: "",
      clientId: null,
      sentBody: null,
    };
    const path = staffView ? `/messages/threads/${data.thread.id}` : "/chat";
    const endpoint = staffView ? `${path}/messages` : "/chat/messages";
    const thread = data.thread;
    element.innerHTML = `${staffView ? `<header class="dm-thread-heading"><div><h2>${h(thread.display_name)}</h2><p>${h(roles[thread.role] || "Гость")} · личный диалог</p>${thread.guest_email ? `<p class="dm-caption">${h(thread.guest_email)} · почта не подтверждена</p>` : ""}</div>${thread.owner_user_id ? `<a class="button secondary" href="#users/${h(thread.owner_user_id)}">Профиль</a>` : ""}</header>` : ""}${data.event ? `<a class="dm-event-context" href="#opportunities/${h(data.event.id)}">${h(data.event.title)}</a>` : ""}<div class="dm-history" tabindex="0" aria-label="История разговора"><button type="button" class="dm-older button ghost" ${data.has_more ? "" : "hidden"}>Загрузить предыдущие</button><div class="dm-message-list"></div></div><button type="button" class="dm-new-messages button ghost" hidden>Новые сообщения ↓</button><form class="dm-message-form">${area(staffView ? "Ответ" : "Сообщение", "body", draft.body, 'required aria-label="Сообщение"')}<div class="form-error" role="alert"></div><div class="dm-compose-footer"><p class="dm-caption">${staffView ? "Ответ видит только этот собеседник." : "Личный разговор с командой фонда"}</p><button type="submit" class="button" ${!draft.body.trim() ? "disabled" : ""}>Отправить</button></div><div class="dm-live" role="status" aria-live="polite"></div></form>`;
    const history = element.querySelector(".dm-history"),
      list = element.querySelector(".dm-message-list"),
      form = element.querySelector("form"),
      input = form.elements.body,
      submit = form.querySelector('[type="submit"]'),
      error = form.querySelector(".form-error"),
      live = form.querySelector(".dm-live"),
      older = element.querySelector(".dm-older"),
      fresh = element.querySelector(".dm-new-messages");
    const eventLink = element.querySelector(".dm-event-context");
    if (eventLink) {
      const image = document.createElement("img");
      image.src = "/assets/figma/aa759.svg";
      image.alt = "";
      image.width = 24;
      image.height = 24;
      eventLink.prepend(image);
    }
    const valid = () => !stopped && alive() && element.isConnected;
    const nearEnd = () =>
      history.scrollHeight - history.scrollTop - history.clientHeight < 60;
    const scrollEnd = () => {
      history.scrollTo({
        top: history.scrollHeight,
        behavior: reduced() ? "instant" : "smooth",
      });
      fresh.hidden = true;
    };
    const markRead = async () => {
      const id = serverCursor;
      if (
        !id ||
        Number(id) <= Number(readId) ||
        !valid() ||
        document.hidden ||
        reading
      )
        return;
      reading = true;
      try {
        await request(context, `${path}/read`, { message_id: Number(id) });
        if (valid()) readId = id;
      } catch {
        /* Retry when the history is opened or refreshed. */
      } finally {
        reading = false;
      }
    };
    const draw = () => {
      items = items.map((item) => ({
        ...item,
        read:
          Number(item.id) <=
          Number(
            item.sender_kind === "organizer"
              ? data.thread?.owner_read_id
              : data.thread?.staff_read_id,
          ),
      }));
      list.innerHTML = items.length
        ? items.map((item) => messageHTML(item, staffView)).join("")
        : '<p class="dm-empty">Здесь появится ваш разговор с фондом. Напишите первый вопрос.</p>';
      older.hidden = !data.has_more;
    };
    draw();
    history.scrollTop = history.scrollHeight;
    void markRead();
    input.addEventListener("input", () => {
      draft.body = input.value;
      drafts.set(draftKey, draft);
      submit.disabled = pending || !input.value.trim();
    });
    fresh.addEventListener("click", () => {
      scrollEnd();
      void markRead();
    });
    history.addEventListener("scroll", () => {
      if (nearEnd()) {
        fresh.hidden = true;
        void markRead();
      }
    });
    older.addEventListener("click", async () => {
      if (loading || !items.length) return;
      loading = true;
      older.disabled = true;
      try {
        const response = await request(
          context,
          `${path}?before_id=${encodeURIComponent(items[0].id)}`,
        );
        if (!valid()) return;
        const height = history.scrollHeight,
          top = history.scrollTop;
        const known = new Set(items.map((item) => String(item.id)));
        items = [
          ...response.items.filter((item) => !known.has(String(item.id))),
          ...items,
        ];
        data.has_more = response.has_more;
        draw();
        history.scrollTop = top + history.scrollHeight - height;
      } catch (e) {
        if (valid()) error.textContent = e.message;
      } finally {
        loading = false;
        if (valid()) {
          older.disabled = false;
          if (catchupPending) void refresh();
        }
      }
    });
    const refresh = async (forceBottom = false) => {
      if (!valid() || document.hidden) return;
      if (loading) {
        catchupPending = true;
        return;
      }
      catchupPending = false;
      loading = true;
      const atEnd = nearEnd(),
        top = history.scrollTop;
      try {
        const response = await request(
          context,
          `${path}${serverCursor ? `?after_id=${encodeURIComponent(serverCursor)}` : ""}`,
        );
        if (!valid()) return;
        const known = new Set(items.map((item) => String(item.id)));
        const incoming = response.items.filter(
          (item) => !known.has(String(item.id)),
        );
        merge(response.items);
        data.thread = response.thread;
        if (!serverCursor) data.has_more = response.has_more;
        else if (response.has_more && response.items.length)
          catchupPending = true;
        serverCursor = Number(response.items.at(-1)?.id) || serverCursor;
        draw();
        if (forceBottom || atEnd) {
          history.scrollTop = history.scrollHeight;
          void markRead();
        } else {
          history.scrollTop = top;
          if (incoming.length) fresh.hidden = false;
        }
      } catch (e) {
        if (valid()) {
          error.textContent = e.message;
          if ([401, 403].includes(e.status)) stop();
        }
      } finally {
        loading = false;
        if (catchupPending && valid()) void refresh();
      }
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body || pending || !valid()) return;
      pending = true;
      submit.disabled = true;
      error.textContent = "";
      if (!draft.clientId || draft.sentBody !== body) {
        draft.clientId = crypto.randomUUID();
        draft.sentBody = body;
      }
      drafts.set(draftKey, draft);
      try {
        const payload = { body, client_id: draft.clientId };
        if (!staffView && eventId) payload.opportunity_id = Number(eventId);
        const response = await request(context, endpoint, payload);
        if (!valid()) return;
        merge([
          { ...response.message, sender_name: context.user?.full_name || "Вы" },
        ]);
        input.value = "";
        draft.body = "";
        draft.clientId = null;
        draft.sentBody = null;
        drafts.delete(draftKey);
        draw();
        scrollEnd();
        live.textContent = "Сообщение отправлено.";
        await refresh(true);
      } catch (e) {
        if (valid()) error.textContent = e.message;
      } finally {
        pending = false;
        if (valid()) submit.disabled = !input.value.trim();
      }
    });
    const timer = setInterval(() => {
      if (!valid()) stop();
      else if (!pending) void refresh();
    }, 10000);
    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      draft.body = input.value;
      if (draft.body) drafts.set(draftKey, draft);
    }
    return stop;
  }

  async function openChat(context) {
    if (activeModal?.dialog.classList.contains("dm-chat-dialog")) return;
    let stop = null;
    const instance = modal(
      `<header class="dm-modal-header"><h2 id="dm-modal-title">Чат с фондом</h2>${closeButton}</header><div class="dm-chat-content"><p role="status">Загружаем разговор…</p></div>`,
      { chat: true, onClose: () => stop?.() },
    );
    const content = instance.dialog.querySelector(".dm-chat-content");
    const key = `chat:${context.user?.id || "guest"}`;
    const show = (data) => {
      if (!instance.alive()) return;
      instance.dialog.querySelector("h2").textContent = "Чат с фондом";
      content.innerHTML = `<p class="dm-recipient">Организаторы «Детей Марии»</p><p class="dm-intro">Задайте вопрос о волонтёрстве, обучении или встрече. Ответ появится здесь${context.user ? " и в уведомлениях" : ""}.</p>${!context.user ? '<p class="dm-caption">Ответ доступен в этом браузере, пока действует гостевая сессия. Отправка на почту сейчас недоступна. После выхода из сессии восстановить разговор по адресу почты нельзя.</p>' : ""}<div class="dm-chat-conversation"></div>`;
      stop = conversation(
        content.querySelector(".dm-chat-conversation"),
        context,
        {
          initial: data,
          alive: instance.alive,
          eventId: context.eventId,
          draftKey: key,
        },
      );
    };
    const load = async () => {
      try {
        const data = await request(context, "/chat");
        if (!instance.alive()) return;
        if (context.user || data.thread) return show(data);
        instance.dialog.querySelector("h2").textContent =
          "Написать организаторам";
        const saved = drafts.get(key) || {};
        content.innerHTML = `<p class="dm-intro">Можно задать вопрос до регистрации. Представьтесь и оставьте контактную почту.</p><form class="dm-guest-form">${field("Как к вам обращаться", "guest_name", saved.name || "", 'autocomplete="name" maxlength="120"')}${field("Электронная почта *", "guest_email", saved.email || "", 'type="email" required autocomplete="email" maxlength="254"')}${area("Ваш вопрос *", "body", saved.body || "", "required")}<p class="dm-caption">Это новый разговор. Ответ появится в этом чате. Отправка писем сейчас недоступна; сохраняйте доступ к этому браузеру.</p><div class="form-error" role="alert"></div><button type="submit" class="button">Начать разговор</button></form>`;
        const form = content.querySelector("form");
        let busy = false;
        form.addEventListener("input", () => {
          saved.name = form.elements.guest_name.value;
          saved.email = form.elements.guest_email.value;
          saved.body = form.elements.body.value;
          drafts.set(key, saved);
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (busy || !form.reportValidity()) return;
          const values = Object.fromEntries(new FormData(form));
          values.body = values.body.trim();
          if (!values.body) return;
          const signature = JSON.stringify(values);
          if (saved.signature !== signature) {
            saved.clientId = crypto.randomUUID();
            saved.signature = signature;
          }
          values.client_id = saved.clientId;
          if (context.eventId) values.opportunity_id = Number(context.eventId);
          busy = true;
          form.querySelector("button").disabled = true;
          form.querySelector(".form-error").textContent = "";
          try {
            await request(context, "/chat/messages", values);
            if (!instance.alive()) return;
            drafts.delete(key);
            const response = await request(context, "/chat");
            show(response);
          } catch (error) {
            if (instance.alive() && form.isConnected)
              form.querySelector(".form-error").textContent = error.message;
          } finally {
            busy = false;
            if (form.isConnected) form.querySelector("button").disabled = false;
          }
        });
      } catch (error) {
        if (instance.alive()) {
          content.innerHTML = `${errorHTML(error)}<button class="button secondary" type="button">Повторить</button>`;
          content.querySelector("button").addEventListener("click", load);
        }
      }
    };
    await load();
  }

  async function renderInbox(set, context) {
    cleanPage();
    const token = generation;
    if (!isOrganizer(context.user)) {
      set(
        '<div class="notice">Общий список диалогов доступен организатору. Для своего разговора используйте «Чат с фондом».</div>',
      );
      return;
    }
    set(
      `<section class="dm-page" data-dm-root>${pageHead("Обращения в фонд", "Личные вопросы волонтёров и гостей команде фонда.")}${tabbar("inbox")}<form class="dm-filters">${field("Поиск диалога", "q", "", 'placeholder="Имя или текст сообщения" maxlength="120"')}<label class="dm-field"><span>Показать</span><select name="filter"><option value="all">Все диалоги</option><option value="unread">Непрочитанные</option><option value="guest">Гости</option>${Object.entries(
        roles,
      )
        .map(([value, title]) => `<option value="${value}">${title}</option>`)
        .join(
          "",
        )}</select></label><button class="button secondary" type="submit">Найти</button><button class="button secondary" type="button" data-dm-own>Написать организатору</button></form><div class="dm-inbox"><div class="dm-thread-list" aria-label="Диалоги"><p>Загружаем…</p></div><button type="button" class="button secondary dm-mobile-back" data-dm-back>← Все диалоги</button><section class="dm-card dm-selected-thread" tabindex="-1" aria-label="Выбранный диалог"><p class="dm-empty">Выберите диалог из списка.</p></section></div></section>`,
    );
    const root = document.querySelector("[data-dm-root]"),
      filter = root.querySelector("form"),
      list = root.querySelector(".dm-thread-list"),
      panel = root.querySelector(".dm-selected-thread");
    let page = 1,
      selected = context.threadId || null,
      selection = 0,
      stop = null,
      listRequest = 0;
    pageCleanups.add(() => stop?.());
    const valid = () => current(set, token, root);
    const selectThread = async (id) => {
      selected = id;
      const serial = ++selection;
      stop?.();
      stop = null;
      root.classList.add("dm-thread-open");
      panel.innerHTML = '<p role="status">Загружаем разговор…</p>';
      if (window.matchMedia("(max-width: 767px)").matches) {
        root.querySelector("[data-dm-back]").scrollIntoView({ block: "start" });
        panel.focus({ preventScroll: true });
      }
      list
        .querySelectorAll("[data-thread]")
        .forEach((button) =>
          button.classList.toggle(
            "selected",
            button.dataset.thread === String(id),
          ),
        );
      try {
        const data = await request(
          context,
          `/messages/threads/${encodeURIComponent(id)}`,
        );
        if (!valid() || serial !== selection) return;
        stop = conversation(panel, context, {
          initial: data,
          staffView: true,
          alive: () => valid() && serial === selection,
          draftKey: `reply:${context.user.id}:${id}`,
        });
      } catch (error) {
        if (valid() && serial === selection)
          panel.innerHTML = `${errorHTML(error)}<button type="button" class="button secondary" data-thread-retry>Повторить</button>`;
        panel
          .querySelector("[data-thread-retry]")
          ?.addEventListener("click", () => selectThread(id));
      }
    };
    const load = async () => {
      const serial = ++listRequest;
      const query = new URLSearchParams({
        q: filter.elements.q.value,
        filter: filter.elements.filter.value,
        page,
        page_size: 30,
      });
      try {
        const data = await request(context, `/messages/threads?${query}`);
        if (!valid() || serial !== listRequest) return;
        list.innerHTML = `${data.items.map((item) => `<button type="button" class="dm-thread ${String(selected) === String(item.id) ? "selected" : ""}" data-thread="${h(item.id)}"><span class="dm-thread-top"><strong>${h(item.display_name)}</strong><time>${h(date(item.updated_at))}</time></span><span class="dm-thread-role">${h(roles[item.role] || "Гость")}</span><span class="dm-thread-preview">${h(item.last_message)}</span>${item.unread ? '<span class="dm-unread">● Новое сообщение</span>' : ""}</button>`).join("") || '<p class="dm-empty">Диалогов пока нет.</p>'}${pager(data)}`;
        list
          .querySelectorAll("[data-thread]")
          .forEach((button) =>
            button.addEventListener("click", () =>
              selectThread(button.dataset.thread),
            ),
          );
        list.querySelectorAll("[data-dm-page]").forEach((button) =>
          button.addEventListener("click", () => {
            page = Number(button.dataset.dmPage);
            void load();
          }),
        );
        if (selected && !stop) void selectThread(selected);
      } catch (error) {
        if (valid() && serial === listRequest)
          list.innerHTML = errorHTML(error);
      }
    };
    root
      .querySelector("[data-dm-own]")
      .addEventListener("click", () => openChat(context));
    root.querySelector("[data-dm-back]").addEventListener("click", () => {
      const previous = selected;
      selected = null;
      selection++;
      stop?.();
      stop = null;
      root.classList.remove("dm-thread-open");
      panel.innerHTML = '<p class="dm-empty">Выберите диалог из списка.</p>';
      const previousButton = [...list.querySelectorAll("[data-thread]")].find(
        (button) => button.dataset.thread === String(previous),
      );
      previousButton?.classList.remove("selected");
      previousButton?.focus();
    });
    filter.addEventListener("submit", (event) => {
      event.preventDefault();
      page = 1;
      void load();
    });
    filter.elements.filter.addEventListener("change", () => {
      page = 1;
      void load();
    });
    await load();
  }

  async function renderCampaigns(set, context) {
    cleanPage();
    const token = generation;
    if (!isOrganizer(context.user)) {
      set('<div class="notice">Рассылки доступны организатору.</div>');
      return;
    }
    set(
      `<section class="dm-page" data-dm-root>${pageHead("Рассылки", "Отправляйте важные сообщения группам пользователей и участникам встреч.")}${tabbar("campaigns")}<form class="dm-filters">${field("Поиск рассылки", "q", "", 'placeholder="Тема сообщения" maxlength="120"')}<label class="dm-field"><span>Статус</span><select name="status"><option value="all">Все рассылки</option>${Object.entries(
        statuses,
      )
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join(
          "",
        )}</select></label><button class="button secondary" type="submit">Найти</button><a class="button" href="#campaigns/new">Создать рассылку</a></form><section class="dm-card dm-campaign-history"><h2>История рассылок</h2><div data-campaign-list>Загружаем…</div></section><aside class="dm-card dm-callout"><h2>Есть сообщение для одной встречи?</h2><p>Откройте мероприятие и нажмите «Уведомить участников». Событие и подтверждённые участники подставятся в форму.</p><a class="button secondary" href="#opportunities">К мероприятиям</a></aside></section>`,
    );
    const root = document.querySelector("[data-dm-root]"),
      form = root.querySelector("form"),
      list = root.querySelector("[data-campaign-list]");
    let page = 1,
      serial = 0;
    const load = async () => {
      const sequence = ++serial;
      try {
        const data = await request(
          context,
          `/campaigns?${new URLSearchParams({ q: form.elements.q.value, status: form.elements.status.value, page, page_size: 30 })}`,
        );
        if (!current(set, token, root) || sequence !== serial) return;
        list.innerHTML = data.items.length
          ? `<div class="dm-table-scroll" tabindex="0" role="region" aria-label="История рассылок"><table class="dm-campaign-table"><thead><tr><th>Сообщение</th><th>Аудитория</th><th>Когда</th><th>Статус</th></tr></thead><tbody>${data.items.map((item) => `<tr><td><a href="#campaigns/${h(item.id)}">${h(item.title || "Без названия")}</a><small>${item.kind === "event" ? h(item.opportunity_title || "Мероприятие") : "Общая рассылка"}</small></td><td>${item.kind === "event" ? "Участники" : h(item.roles.map((role) => roles[role]).join(", "))}${item.status !== "draft" ? ` · ${h(item.recipient_count)}` : ""}</td><td>${h(date(item.sent_at || item.updated_at))}</td><td>${badge(statuses[item.status])}</td></tr>`).join("")}</tbody></table></div>${pager(data)}`
          : '<p class="dm-empty">Рассылок пока нет. Создайте первый черновик.</p>';
        list.querySelectorAll("[data-dm-page]").forEach((button) =>
          button.addEventListener("click", () => {
            page = Number(button.dataset.dmPage);
            void load();
          }),
        );
      } catch (error) {
        if (current(set, token, root) && sequence === serial)
          list.innerHTML = errorHTML(error);
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      page = 1;
      void load();
    });
    form.elements.status.addEventListener("change", () => {
      page = 1;
      void load();
    });
    await load();
  }

  async function renderCampaignEditor(set, context) {
    cleanPage();
    const token = generation;
    if (!isOrganizer(context.user)) {
      set('<div class="notice">Рассылки доступны организатору.</div>');
      return;
    }
    let campaign = {
      title: "",
      body: "",
      kind: context.eventId ? "event" : "groups",
      roles: ["volunteer", "coordinator", "manager", "admin"],
      opportunity_id: context.eventId ? Number(context.eventId) : null,
      action_label: context.eventId ? "К мероприятию" : "",
      target_type: context.eventId ? "event" : null,
      status: "draft",
    };
    let initialCount = null;
    try {
      if (context.campaignId) {
        const data = await request(
          context,
          `/campaigns/${encodeURIComponent(context.campaignId)}`,
        );
        if (!current(set, token)) return;
        campaign = data.campaign;
        initialCount = data.current_recipient_count;
      }
      if (campaign.opportunity_id && !campaign.opportunity_title) {
        const event = await request(
          context,
          `/opportunities/${encodeURIComponent(campaign.opportunity_id)}`,
        );
        if (!current(set, token)) return;
        campaign.opportunity_title = (
          event.item ||
          event.opportunity ||
          event
        ).title;
      }
    } catch (error) {
      if (current(set, token)) set(errorHTML(error));
      return;
    }
    const readonly = campaign.status !== "draft";
    set(
      `<section class="dm-page" data-dm-root>${pageHead(readonly ? "Рассылка" : campaign.id ? "Черновик рассылки" : "Новая рассылка", "Выберите аудиторию и подготовьте уведомление для сайта.")}${tabbar("campaigns")}<a class="dm-back" href="#campaigns">← Все рассылки</a>${readonly ? `<div class="notice" role="status">${h(statuses[campaign.status])}. Создано уведомлений: ${campaign.delivered_count}. Пропущено: ${campaign.skipped_count}.</div>` : ""}<form class="dm-campaign-form"><div class="dm-campaign-grid"><section class="dm-card"><h2>Получатели</h2><fieldset ${readonly ? "disabled" : ""} class="dm-campaign-fields"><div class="dm-tabs"><label class="dm-choice"><input type="radio" name="kind" value="groups" ${campaign.kind === "groups" ? "checked" : ""}><span>По группам</span></label><label class="dm-choice"><input type="radio" name="kind" value="event" ${campaign.kind === "event" ? "checked" : ""}><span>По мероприятию</span></label></div><div data-group-options><p class="dm-label">Аудитория *</p><div class="dm-role-choices">${[
        ["volunteer", "Волонтёры"],
        ["coordinator", "Координаторы"],
        ["organizers", "Организаторы"],
      ]
        .map(
          ([value, text]) =>
            `<label class="dm-choice"><input type="checkbox" name="audience" value="${value}" ${value === "organizers" ? (campaign.roles.some((role) => ["manager", "admin"].includes(role)) ? "checked" : "") : campaign.roles.includes(value) ? "checked" : ""}><span>${text}</span></label>`,
        )
        .join(
          "",
        )}</div><p class="dm-caption">Гости и закрытые аккаунты не входят в рассылку.</p></div><div data-event-options><label class="dm-field"><span>Мероприятие *</span><input name="event_search" placeholder="Найти опубликованную встречу" maxlength="120"></label><div class="dm-event-controls"><button type="button" class="button secondary" data-find-event>Найти</button><button type="button" class="button ghost" data-event-previous disabled>Назад</button><button type="button" class="button ghost" data-event-next disabled>Далее</button></div><div class="dm-event-results" data-event-results></div><p class="dm-event-selected">${h(campaign.opportunity_title || "Мероприятие не выбрано")}</p><p class="dm-caption">Только подтверждённые участники опубликованного события с действующим доступом.</p></div><hr><h2>Сообщение</h2>${field("Заголовок *", "title", campaign.title, 'maxlength="160"')}${area("Текст уведомления *", "body", campaign.body)}${field("Кнопка в уведомлении", "action_label", campaign.action_label, 'maxlength="60"')}<label class="dm-field"><span>Куда ведёт кнопка</span><select name="target_type"><option value="">Без кнопки</option>${[
        ["opportunities", "Каталог возможностей"],
        ["training", "Обучение"],
        ["dashboard", "Мой кабинет"],
        ["questionnaire", "Своя анкета"],
        ["event", "Карточка мероприятия"],
      ]
        .map(
          ([value, text]) =>
            `<option value="${value}" ${campaign.target_type === value ? "selected" : ""}>${text}</option>`,
        )
        .join(
          "",
        )}</select></label></fieldset></section><aside class="dm-campaign-aside"><section class="dm-card"><h2>Доставка</h2>${badge("Уведомление на сайте")}<p>Появится в личном центре уведомлений получателя.</p><dl><dt>Получателей</dt><dd data-count>${initialCount == null ? "Считаем…" : h(initialCount)}</dd><dt>Отправка</dt><dd>После окончательного подтверждения</dd></dl><p class="dm-caption">Email и SMS не отправляются.</p></section><section class="dm-card dm-campaign-preview"><p class="dm-recipient">Так увидит получатель</p><h2 data-preview-title></h2><p data-preview-body></p><span class="button secondary dm-preview-action" data-preview-action hidden></span></section></aside></div><div class="form-error" role="alert"></div>${!readonly ? '<div class="dm-campaign-actions"><button class="button secondary" type="button" data-save-draft>Сохранить черновик</button><button class="button" type="submit">Проверить и отправить</button></div>' : ""}<div class="dm-live" role="status" aria-live="polite"></div></form></section>`,
    );
    const root = document.querySelector("[data-dm-root]"),
      form = root.querySelector("form"),
      error = form.querySelector(".form-error"),
      live = form.querySelector(".dm-live");
    let busy = false,
      countTimer,
      countSequence = 0,
      eventPage = 1,
      eventSequence = 0,
      creationId = crypto.randomUUID(),
      lastRecipientCount = initialCount;
    const valid = () => current(set, token, root);
    pageCleanups.add(() => clearTimeout(countTimer));
    const payload = () => {
      const data = new FormData(form),
        kind = data.get("kind") || campaign.kind;
      return {
        title: String(data.get("title") ?? campaign.title),
        body: String(data.get("body") ?? campaign.body),
        kind,
        roles: readonly
          ? campaign.roles
          : data
              .getAll("audience")
              .flatMap((value) =>
                value === "organizers" ? ["manager", "admin"] : [value],
              ),
        opportunity_id: kind === "event" ? campaign.opportunity_id : null,
        action_label: String(data.get("action_label") ?? campaign.action_label),
        target_type:
          kind === "event"
            ? String(data.get("action_label") ?? campaign.action_label).trim()
              ? "event"
              : null
            : (data.get("target_type") ?? campaign.target_type) || null,
      };
    };
    const update = () => {
      const data = payload();
      root.querySelector("[data-group-options]").hidden =
        data.kind !== "groups";
      root.querySelector("[data-event-options]").hidden = data.kind !== "event";
      const eventOption =
        form.elements.target_type.querySelector('[value="event"]');
      eventOption.disabled = data.kind !== "event";
      if (data.kind !== "event" && form.elements.target_type.value === "event")
        form.elements.target_type.value = "";
      if (data.kind === "event")
        form.elements.target_type.value = data.action_label.trim()
          ? "event"
          : "";
      form.elements.target_type.disabled = readonly || data.kind === "event";
      root.querySelector("[data-preview-title]").textContent =
        data.title || "Заголовок уведомления";
      root.querySelector("[data-preview-body]").textContent =
        data.body || "Здесь появится ваш текст.";
      const button = root.querySelector("[data-preview-action]");
      button.textContent = data.action_label;
      button.hidden = !data.action_label;
    };
    const count = async () => {
      const sequence = ++countSequence;
      try {
        const result = await request(
          context,
          "/campaigns/audience-preview",
          payload(),
        );
        if (valid() && sequence === countSequence) {
          lastRecipientCount = result.recipient_count;
          root.querySelector("[data-count]").textContent =
            result.recipient_count
              ? `${result.recipient_count} пользователей`
              : "Нет доступных получателей";
          setBusy(busy);
        }
      } catch (e) {
        if (valid() && sequence === countSequence)
          root.querySelector("[data-count]").textContent =
            "Не удалось посчитать. Повторите проверку.";
      }
    };
    form.addEventListener("input", () => {
      update();
    });
    form.addEventListener("change", () => {
      update();
      clearTimeout(countTimer);
      countTimer = setTimeout(count, 300);
    });
    update();
    if (!readonly) void count();
    const findEvents = async () => {
      const sequence = ++eventSequence,
        results = root.querySelector("[data-event-results]");
      results.textContent = "Ищем мероприятия…";
      try {
        const data = await request(
          context,
          `/opportunities?${new URLSearchParams({ q: form.elements.event_search.value, status: "open", page: eventPage, page_size: 20 })}`,
        );
        if (!valid() || sequence !== eventSequence) return;
        results.innerHTML =
          data.items
            .map(
              (item) =>
                `<button type="button" class="dm-event-choice" data-event="${h(item.id)}">${h(item.title)}</button>`,
            )
            .join("") || '<p class="dm-caption">Мероприятия не найдены.</p>';
        root.querySelector("[data-event-previous]").disabled = data.page <= 1;
        root.querySelector("[data-event-next]").disabled =
          data.page >= data.pages;
        results.querySelectorAll("[data-event]").forEach((button) =>
          button.addEventListener("click", () => {
            campaign.opportunity_id = Number(button.dataset.event);
            campaign.opportunity_title = button.textContent;
            root.querySelector(".dm-event-selected").textContent =
              button.textContent;
            if (!form.elements.action_label.value)
              form.elements.action_label.value = "К мероприятию";
            form.elements.target_type.value = "event";
            update();
            void count();
          }),
        );
      } catch (e) {
        if (valid() && sequence === eventSequence)
          results.innerHTML = errorHTML(e);
      }
    };
    root.querySelector("[data-find-event]").addEventListener("click", () => {
      eventPage = 1;
      void findEvents();
    });
    root
      .querySelector("[data-event-previous]")
      .addEventListener("click", () => {
        eventPage--;
        void findEvents();
      });
    root.querySelector("[data-event-next]").addEventListener("click", () => {
      eventPage++;
      void findEvents();
    });
    const setBusy = (value) => {
      busy = value;
      form.querySelectorAll(".dm-campaign-actions button").forEach((button) => {
        button.disabled =
          value ||
          campaign.status !== "draft" ||
          (button.type === "submit" && lastRecipientCount === 0);
      });
    };
    const save = async () => {
      const data = payload();
      const response = campaign.id
        ? await request(
            context,
            `/campaigns/${campaign.id}`,
            { ...data, expected_version: campaign.version },
            "PATCH",
          )
        : await request(context, "/campaigns", {
            ...data,
            client_id: creationId,
          });
      if (!valid()) return null;
      campaign = { ...campaign, ...response.campaign };
      history.replaceState(null, "", `#campaigns/${campaign.id}`);
      window.PortalUI?.syncHash?.();
      return campaign;
    };
    form
      .querySelector("[data-save-draft]")
      ?.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        error.textContent = "";
        try {
          const saved = await save();
          if (!saved || !valid()) return;
          const savedDialog = modal(
            `${successMark}<h2 id="dm-modal-title">Черновик сохранён</h2><p>Можно вернуться к сообщению и отправить его позже.</p><button type="button" class="button" data-dm-close>Продолжить редактирование</button>`,
          );
          savedDialog.dialog.classList.add("dm-draft-dialog");
          live.textContent = "Черновик сохранён.";
        } catch (e) {
          if (valid()) error.textContent = e.message;
        } finally {
          if (valid()) setBusy(false);
        }
      });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || readonly) return;
      const data = payload();
      if (!data.title.trim() || !data.body.trim()) {
        error.textContent = "Заполните заголовок и текст уведомления.";
        return;
      }
      setBusy(true);
      error.textContent = "";
      try {
        const saved = await save();
        if (!saved || !valid()) return;
        const review = await request(context, `/campaigns/${saved.id}/review`, {
          expected_version: saved.version,
        });
        if (!valid()) return;
        showReview(review, context, valid, () => {
          campaign.status = "queued";
          form.querySelector("fieldset").disabled = true;
          form
            .querySelectorAll(".dm-campaign-actions button")
            .forEach((button) => {
              button.disabled = true;
            });
          live.textContent =
            "Рассылка передана на отправку. Состояние доступно в истории рассылок.";
        });
      } catch (e) {
        if (valid()) error.textContent = e.message;
      } finally {
        if (valid()) setBusy(false);
      }
    });
  }

  function showReview(review, context, pageAlive, onQueued) {
    let poll = null,
      busy = false;
    const campaign = review.campaign;
    const instance = modal(
      `<header class="dm-modal-header"><h2 id="dm-modal-title">Проверьте уведомление</h2>${closeButton}</header><div class="dm-review-body"><section class="dm-review-audience"><h2>${review.recipient_count} получателей</h2><p>${campaign.kind === "event" ? h(campaign.opportunity_title || "Мероприятие") : h(campaign.roles.map((role) => roles[role]).join(", "))}</p><p class="dm-caption">Гости и закрытые аккаунты не включены.</p></section><h2>${h(campaign.title)}</h2><p class="dm-review-text">${h(campaign.body)}</p>${campaign.action_label ? `<span class="dm-caption">Кнопка: ${h(campaign.action_label)}</span>` : ""}<p class="dm-review-channel">Канал: уведомление на сайте · отправка сразу после подтверждения</p><div class="form-error" role="alert"></div><div class="dm-review-actions"><button type="button" class="button secondary" data-dm-close>Назад</button><button type="button" class="button" data-confirm>Отправить ${review.recipient_count} получателям</button></div></div>`,
      {
        onClose: () => {
          if (poll) clearTimeout(poll);
        },
      },
    );
    const showProgress = async () => {
      try {
        const result = await request(context, `/campaigns/${campaign.id}`);
        if (!instance.alive() || !pageAlive()) return;
        const item = result.campaign,
          complete = item.status === "sent" || item.status === "cancelled";
        if (item.status === "sent") {
          instance.dialog.innerHTML = `${successMark}<h2 id="dm-modal-title">Уведомления отправлены</h2><p role="status">Создано уведомлений: ${item.delivered_count}.${item.skipped_count ? ` Пропущено после изменения доступа: ${item.skipped_count}.` : ""}</p><p class="dm-caption">Сообщение появилось в личном центре уведомлений получателей.</p><a class="button" href="${item.kind === "event" && item.opportunity_id ? `#opportunities/${h(item.opportunity_id)}` : "#campaigns"}" data-finish>${item.kind === "event" ? "К мероприятию" : "К рассылкам"}</a>`;
          instance.dialog
            .querySelector("[data-finish]")
            .addEventListener("click", () => instance.close());
          return;
        }
        instance.dialog.querySelector("#dm-modal-title").textContent =
          item.status === "sent"
            ? "Рассылка отправлена"
            : item.status === "cancelled"
              ? "Рассылка остановлена"
              : "Отправляем уведомления";
        instance.dialog.querySelector(".dm-review-body").innerHTML =
          `<p role="status">Создано уведомлений: <strong>${item.delivered_count}</strong> из ${item.recipient_count}.${item.skipped_count ? ` Пропущено после изменения доступа: ${item.skipped_count}.` : ""}</p>${!complete ? "<p>Можно закрыть это окно. Отправка продолжится на сервере.</p>" : ""}<a class="button" href="#campaigns" data-finish>К рассылкам</a>`;
        instance.dialog
          .querySelector("[data-finish]")
          .addEventListener("click", () => instance.close());
        if (!complete) poll = setTimeout(showProgress, 2000);
      } catch (e) {
        if (instance.alive())
          instance.dialog.querySelector(".dm-review-body").innerHTML =
            `${errorHTML(e)}<p>Состояние можно проверить в истории рассылок. Повторная отправка не выполняется.</p><a href="#campaigns" class="button secondary" data-finish>К рассылкам</a>`;
        instance.dialog
          .querySelector("[data-finish]")
          ?.addEventListener("click", () => instance.close());
      }
    };
    instance.dialog
      .querySelector("[data-confirm]")
      .addEventListener("click", async () => {
        if (busy || !pageAlive()) return;
        busy = true;
        const button = instance.dialog.querySelector("[data-confirm]");
        button.disabled = true;
        instance.dialog.querySelector(".form-error").textContent = "";
        try {
          await request(context, `/campaigns/${campaign.id}/send`, {
            review_token: review.review_token,
          });
          if (pageAlive()) onQueued?.();
          if (instance.alive()) await showProgress();
        } catch (e) {
          if (instance.alive()) {
            instance.dialog.querySelector(".form-error").textContent =
              e.message;
            button.disabled = false;
          }
        } finally {
          busy = false;
        }
      });
  }

  window.DMMessaging = {
    openChat,
    renderInbox,
    renderCampaigns,
    renderCampaignEditor,
    deactivate,
    destroy,
  };
})();
