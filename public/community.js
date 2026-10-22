"use strict";

window.PortalCommunity = (() => {
  let generation = 0;
  const cleanups = new Set(),
    drafts = new Map();
  const roles = {
    volunteer: "Волонтёр",
    coordinator: "Координатор",
    manager: "Организатор",
    admin: "Администратор",
  };
  const time = (value) =>
    value
      ? new Date(value).toLocaleString("ru-RU", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  function deactivate() {
    generation++;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  function destroy() {
    deactivate();
    drafts.clear();
  }
  const post = (api, path, body) =>
    api(path, { method: "POST", body: JSON.stringify(body) });
  const pageButtons = (data, kind) =>
    `<div class="dm-pager"><button class="button secondary" type="button" data-${kind}-page="${number(data.page) - 1}" ${data.page <= 1 ? "disabled" : ""}>Назад</button><span>Страница ${number(data.page)} из ${Math.max(1, number(data.pages))} · ${number(data.total)}</span><button class="button secondary" type="button" data-${kind}-page="${number(data.page) + 1}" ${data.page >= data.pages ? "disabled" : ""}>Далее</button></div>`;
  async function render({ set, api, user, groupId, eventId }) {
    deactivate();
    const token = generation;
    const organizer = ["manager", "admin"].includes(user?.role);
    if (
      !set(
        `<section class="dm-page community-page" data-community-root>${header("Сообщения", "Общайтесь с участниками встреч и командой фонда.")}<nav class="dm-tabs" aria-label="Раздел сообщений"><a class="dm-chip selected" href="#groups" aria-current="page">Общение</a>${organizer ? '<a class="dm-chip" href="#messages">Обращения в фонд</a><a class="dm-chip" href="#campaigns">Рассылки</a>' : ""}<button class="button secondary" type="button" data-community-support>Чат с фондом</button></nav><p class="dm-caption">Группы встреч доступны подтверждённым участникам и команде. Личный диалог можно начать из списка участников встречи.</p><div class="dm-inbox"><aside class="dm-thread-list" aria-label="Группы и личные диалоги"><div class="actions"><h2>Ваши разговоры</h2><button class="button secondary" type="button" data-community-reload>Обновить</button></div><div data-community-list>Загружаем…</div></aside><a href="#groups" class="button secondary dm-mobile-back">← Все разговоры</a><section class="dm-card dm-selected-thread" tabindex="-1" aria-label="Выбранный разговор"><p class="dm-empty">Выберите группу или личный диалог.</p></section></div></section>`,
      )
    )
      return;
    const root = document.querySelector("[data-community-root]"),
      listElement = root.querySelector("[data-community-list]"),
      panel = root.querySelector(".dm-selected-thread");
    const valid = () =>
      token === generation && set.current() && root.isConnected;
    let page = 1,
      listSerial = 0;
    root
      .querySelector("[data-community-support]")
      .addEventListener("click", () => DMMessaging.openChat({ api, user }));
    const loadList = async () => {
      const serial = ++listSerial;
      try {
        const result = await api(`/groups?page=${page}&page_size=20`);
        if (!valid() || serial !== listSerial) return;
        const badge = document.getElementById("group-unread-badge");
        if (badge && result.unread != null) {
          const unread = number(result.unread);
          badge.textContent = unread > 99 ? "99+" : unread;
          badge.hidden = !unread;
        }
        listElement.innerHTML =
          list(result.items)
            .map(
              (group) =>
                `<a class="dm-thread ${String(group.id) === String(groupId) ? "selected" : ""}" href="#groups/${h(group.id)}"><span class="dm-thread-top"><strong>${h(group.title || group.peer?.full_name || group.opportunity_title)}</strong><time>${h(time(group.last_message_at))}</time></span><span class="dm-thread-role">${group.kind === "direct" ? "Личный диалог" : "Группа встречи"}${group.read_only ? " · только чтение" : ""}</span><span class="dm-thread-preview">${h(group.last_message?.body || "Сообщений пока нет")}</span>${group.unread ? '<span class="dm-unread">● Непрочитанные сообщения</span>' : ""}</a>`,
            )
            .join("") ||
          '<p class="dm-empty">Разговоров пока нет. После подтверждения участия здесь появится группа встречи.</p>';
        listElement.insertAdjacentHTML(
          "beforeend",
          pageButtons(result, "group"),
        );
        listElement.querySelectorAll("[data-group-page]").forEach((button) =>
          button.addEventListener("click", () => {
            page = Number(button.dataset.groupPage);
            void loadList();
          }),
        );
      } catch (error) {
        if (valid() && serial === listSerial)
          listElement.innerHTML = `<p class="notice error" role="alert">${h(error.message)}</p>`;
      }
    };
    root
      .querySelector("[data-community-reload]")
      .addEventListener("click", loadList);
    if (eventId || groupId) root.classList.add("dm-thread-open");
    if (eventId) {
      try {
        const response = await api(
          `/groups/events/${encodeURIComponent(eventId)}`,
        );
        if (!valid()) return;
        groupId = response.item.id;
      } catch (error) {
        if (valid())
          panel.innerHTML = `<p class="notice error" role="alert">${h(error.message)}</p>`;
      }
    }
    await loadList();
    if (!valid() || !groupId) return;
    root.classList.add("dm-thread-open");
    panel.innerHTML = '<p role="status">Загружаем разговор…</p>';
    try {
      const result = await api(
        `/groups/${encodeURIComponent(groupId)}/messages`,
      );
      if (!valid()) return;
      openConversation({ api, user, groupId, result, panel, valid, loadList });
      if (window.matchMedia("(max-width: 767px)").matches)
        panel.focus({ preventScroll: true });
    } catch (error) {
      if (valid())
        panel.innerHTML = `<p class="notice error" role="alert">${h(error.message)}</p>`;
    }
  }
  function openConversation({
    api,
    user,
    groupId,
    result,
    panel,
    valid,
    loadList,
  }) {
    const path = `/groups/${encodeURIComponent(groupId)}`;
    let group = result.group,
      messages = list(result.items),
      hasMore = result.has_more;
    // Only fetched history advances this cursor; our POST may overtake another sender.
    let serverCursor = Number(messages.at(-1)?.id) || 0,
      catchupPending = false;
    const merge = (incoming) => {
      const byId = new Map(messages.map((item) => [String(item.id), item]));
      for (const item of incoming) byId.set(String(item.id), item);
      messages = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
    };
    let loading = false,
      sending = false,
      stopped = false,
      lastRead = 0,
      reading = false;
    const draftKey = `${user.id}:${groupId}`,
      draft = drafts.get(draftKey) || {
        body: "",
        kind: "message",
        clientId: null,
        signature: null,
      };
    panel.innerHTML = `<header class="dm-thread-heading"><div><h2>${h(group.title || group.peer?.full_name || group.opportunity_title)}</h2><p>${group.kind === "direct" ? "Личный диалог участников" : "Группа встречи"}</p></div></header>${group.opportunity_id ? `<a class="dm-event-context" href="#opportunities/${h(group.opportunity_id)}">${h(group.opportunity_title || "Открыть встречу")}</a>` : ""}${group.kind === "event" ? '<details class="community-members"><summary>Участники встречи</summary><form class="community-member-filter"><label class="dm-field"><span>Найти участника</span><input name="q" maxlength="120" placeholder="Имя"></label><button class="button secondary" type="submit">Найти</button></form><div data-community-members></div></details>' : ""}<p class="notice" data-community-readonly hidden>Встреча закрыта или удалена. История доступна только для чтения.</p><div class="dm-history" tabindex="0" aria-label="История разговора"><button class="button secondary" type="button" data-community-older ${hasMore ? "" : "hidden"}>Загрузить предыдущие</button><div class="dm-message-list"></div></div><button type="button" class="button secondary" data-community-fresh hidden>Новые сообщения ↓</button><form class="dm-message-form community-compose"><label class="dm-field"><span>Сообщение</span><textarea name="body" rows="3" required maxlength="4000">${h(draft.body)}</textarea></label><label class="dm-field" data-community-kind><span>Тип сообщения</span><select name="kind"><option value="message">Сообщение</option><option value="announcement">Объявление организатора</option></select></label><div class="form-error" role="alert"></div><div class="dm-compose-footer"><span class="dm-caption">${group.kind === "direct" ? "Сообщение увидит только собеседник." : "Сообщение увидят участники этой встречи."}</span><button class="button" type="submit">Отправить</button></div><p class="dm-live" role="status" aria-live="polite"></p></form>`;
    const history = panel.querySelector(".dm-history"),
      messageList = panel.querySelector(".dm-message-list"),
      form = panel.querySelector(".community-compose"),
      input = form.elements.body,
      kind = form.elements.kind,
      submitButton = form.querySelector('[type="submit"]'),
      error = form.querySelector(".form-error"),
      live = form.querySelector(".dm-live"),
      older = panel.querySelector("[data-community-older]"),
      fresh = panel.querySelector("[data-community-fresh]");
    kind.value = draft.kind;
    const alive = () => valid() && !stopped && panel.isConnected;
    const atEnd = () =>
      history.scrollHeight - history.scrollTop - history.clientHeight < 60;
    const canSend = () => !group.read_only;
    const permissions = () => {
      panel.querySelector("[data-community-readonly]").hidden =
        !group.read_only;
      input.disabled = group.read_only;
      kind.disabled = !group.can_announce || group.read_only;
      panel.querySelector("[data-community-kind]").hidden = !group.can_announce;
      if (!group.can_announce) kind.value = "message";
      panel.querySelectorAll("[data-community-direct]").forEach((button) => {
        button.disabled = group.read_only;
      });
      submitButton.disabled = sending || !canSend() || !input.value.trim();
    };
    const draw = () => {
      // Message bodies and participant labels remain plain text, including announcements.
      messageList.innerHTML = messages.length
        ? messages
            .map(
              (message) =>
                `<div class="dm-message-row ${message.is_mine ? "outgoing" : ""}"><article class="dm-bubble ${message.kind === "announcement" ? "community-announcement" : ""}"><div class="dm-author">${h(message.sender_name || "Команда фонда")}${message.is_mine ? " · вы" : ""}${message.kind === "announcement" ? " · объявление" : ""}</div><p>${h(message.body)}</p><div class="dm-caption">${h(time(message.created_at))}</div></article></div>`,
            )
            .join("")
        : '<p class="dm-empty">Здесь пока нет сообщений.</p>';
      older.hidden = !hasMore;
      permissions();
    };
    const read = async () => {
      const id = serverCursor;
      if (!id || id <= lastRead || reading || !alive() || document.hidden)
        return;
      reading = true;
      try {
        await post(api, `${path}/read`, { message_id: id });
        if (alive()) {
          lastRead = id;
          void loadList();
        }
      } catch {
        /* Reading is retried while the conversation remains open. */
      } finally {
        reading = false;
      }
    };
    const end = () => {
      history.scrollTop = history.scrollHeight;
      fresh.hidden = true;
      void read();
    };
    draw();
    end();
    function stop() {
      stopped = true;
      clearInterval(timer);
    }
    const refresh = async () => {
      if (!alive() || document.hidden) return;
      if (loading || sending) {
        catchupPending = true;
        return;
      }
      catchupPending = false;
      loading = true;
      const nearEnd = atEnd(),
        top = history.scrollTop;
      try {
        const next = await api(
          `${path}/messages${serverCursor ? `?after_id=${encodeURIComponent(serverCursor)}` : ""}`,
        );
        if (!alive()) return;
        const known = new Set(messages.map((item) => String(item.id)));
        const added = list(next.items).filter(
          (item) => !known.has(String(item.id)),
        );
        merge(list(next.items));
        if (!serverCursor) hasMore = next.has_more;
        else if (next.has_more && list(next.items).length)
          catchupPending = true;
        serverCursor = Number(list(next.items).at(-1)?.id) || serverCursor;
        group = next.group;
        draw();
        if (nearEnd) end();
        else {
          history.scrollTop = top;
          if (added.length) fresh.hidden = false;
        }
      } catch (failure) {
        if (alive()) {
          if ([401, 403, 404].includes(failure.status)) {
            stop();
            panel.innerHTML = `<p class="notice error" role="alert">${h(failure.message)}</p>`;
          } else error.textContent = failure.message;
        }
      } finally {
        loading = false;
        if (catchupPending && alive()) void refresh();
      }
    };
    older.addEventListener("click", async () => {
      if (loading || !messages.length || !alive()) return;
      loading = true;
      older.disabled = true;
      const height = history.scrollHeight,
        top = history.scrollTop;
      try {
        const previous = await api(
          `${path}/messages?before_id=${encodeURIComponent(messages[0].id)}`,
        );
        if (!alive()) return;
        const known = new Set(messages.map((item) => String(item.id)));
        messages = [
          ...list(previous.items).filter((item) => !known.has(String(item.id))),
          ...messages,
        ];
        hasMore = previous.has_more;
        group = previous.group;
        draw();
        history.scrollTop = top + history.scrollHeight - height;
      } catch (failure) {
        if (alive()) error.textContent = failure.message;
      } finally {
        loading = false;
        if (alive()) {
          older.disabled = false;
          if (catchupPending) void refresh();
        }
      }
    });
    fresh.addEventListener("click", end);
    history.addEventListener("scroll", () => {
      if (atEnd()) {
        fresh.hidden = true;
        void read();
      }
    });
    form.addEventListener("input", () => {
      draft.body = input.value;
      draft.kind = kind.value;
      drafts.set(draftKey, draft);
      permissions();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (sending || !canSend() || !input.value.trim() || !alive()) return;
      const body = input.value.trim(),
        messageKind = group.can_announce ? kind.value : "message";
      const signature = JSON.stringify([body, messageKind]);
      if (draft.signature !== signature) {
        draft.signature = signature;
        draft.clientId = crypto.randomUUID();
      }
      sending = true;
      permissions();
      error.textContent = "";
      try {
        const sent = await post(api, `${path}/messages`, {
          body,
          kind: messageKind,
          client_id: draft.clientId,
        });
        if (!alive()) return;
        merge([{ ...sent.message, is_mine: true }]);
        input.value = "";
        draft.body = "";
        draft.clientId = null;
        draft.signature = null;
        drafts.delete(draftKey);
        draw();
        end();
        live.textContent = "Сообщение отправлено.";
        void loadList();
      } catch (failure) {
        if (alive()) error.textContent = failure.message;
      } finally {
        sending = false;
        if (alive()) {
          permissions();
          void refresh();
        }
      }
    });
    const timer = setInterval(refresh, 10000);
    cleanups.add(stop);
    const details = panel.querySelector(".community-members");
    if (details) {
      const memberForm = details.querySelector("form"),
        members = details.querySelector("[data-community-members]");
      let memberPage = 1,
        memberSequence = 0,
        loaded = false;
      const loadMembers = async () => {
        const serial = ++memberSequence;
        try {
          const response = await api(
            `${path}/members?${new URLSearchParams({ q: memberForm.elements.q.value, page: memberPage, page_size: 20 })}`,
          );
          if (!alive() || serial !== memberSequence) return;
          loaded = true;
          members.innerHTML = `<ul class="community-member-list">${list(
            response.items,
          )
            .map(
              (member) =>
                `<li><span>${h(member.full_name)}<small>${h(roles[member.role] || "Участник")}</small></span>${String(member.id) !== String(user.id) && !group.read_only ? `<button class="button secondary" type="button" data-community-direct="${h(member.id)}">Написать лично</button>` : ""}</li>`,
            )
            .join(
              "",
            )}</ul>${response.items.length ? "" : '<p class="dm-empty">Участники не найдены.</p>'}${pageButtons(response, "member")}<p class="form-error" role="alert"></p>`;
          members.querySelectorAll("[data-member-page]").forEach((button) =>
            button.addEventListener("click", () => {
              memberPage = Number(button.dataset.memberPage);
              void loadMembers();
            }),
          );
          members
            .querySelectorAll("[data-community-direct]")
            .forEach((button) =>
              button.addEventListener("click", async () => {
                button.disabled = true;
                try {
                  const direct = await post(api, `${path}/direct`, {
                    user_id: Number(button.dataset.communityDirect),
                  });
                  // A completed request must not move a user who already left this screen.
                  if (alive() && button.isConnected)
                    location.hash = `groups/${direct.item.id}`;
                } catch (failure) {
                  if (alive())
                    members.querySelector(".form-error").textContent =
                      failure.message;
                } finally {
                  if (button.isConnected) button.disabled = false;
                }
              }),
            );
        } catch (failure) {
          if (alive() && serial === memberSequence)
            members.innerHTML = `<p class="notice error" role="alert">${h(failure.message)}</p>`;
        }
      };
      details.addEventListener("toggle", () => {
        if (details.open && !loaded) void loadMembers();
      });
      memberForm.addEventListener("submit", (event) => {
        event.preventDefault();
        memberPage = 1;
        void loadMembers();
      });
    }
  }
  return { render, deactivate, destroy };
})();
