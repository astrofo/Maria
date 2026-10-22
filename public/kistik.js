(() => {
  "use strict";

  const h = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const MAX_MESSAGES = 24;
  const MAX_HISTORY = 6;
  const MAX_MESSAGE_LENGTH = 1000;
  const artwork = {
    hello: { src: "/assets/figma/kistik/hello.svg", size: 200 },
    thinking: { src: "/assets/figma/kistik/thinking.svg", size: 240 },
    ready: { src: "/assets/figma/kistik-ready.svg", size: 200 },
  };
  let owner = null;
  let history = [];
  let draft = "";
  let generation = 0;
  let active = null;
  let nextId = 0;

  // Navigation is deliberately narrower than arbitrary model text or URLs.
  function safeHref(value, user) {
    if (typeof value !== "string" || value.length > 200) return "";
    const routes = new Set(["#home", "#opportunities", "#kistik"]);
    if (!user) ["#login", "#register"].forEach((route) => routes.add(route));
    if (user) {
      [
        "#profile",
        "#questionnaire",
        "#training",
        "#participation",
        "#notifications",
        "#thanks",
      ].forEach((route) => routes.add(route));
    }
    if (user?.role === "volunteer") routes.add("#dashboard");
    if (["coordinator", "manager", "admin"].includes(user?.role)) {
      ["#users", "#organizer-events", "#staff-tasks"].forEach((route) =>
        routes.add(route),
      );
    }
    if (["manager", "admin"].includes(user?.role)) {
      ["#messages", "#campaigns", "#analytics"].forEach((route) =>
        routes.add(route),
      );
    }
    if (user?.role === "admin")
      ["#access", "#audit"].forEach((route) => routes.add(route));
    return routes.has(value) ? value : "";
  }

  function cleanLinks(items, user, actions = false) {
    return (Array.isArray(items) ? items : []).slice(0, 6).flatMap((item) => {
      const href = safeHref(item?.href, user);
      const label = actions ? item?.label : item?.title;
      return href && typeof label === "string" && label.trim()
        ? [{ href, label: label.slice(0, 160), id: String(item.id || "") }]
        : [];
    });
  }

  function normalizeReply(data, user) {
    if (typeof data?.answer !== "string" || !data.answer.trim()) return null;
    return {
      id: ++nextId,
      role: "assistant",
      content: data.answer.trim().slice(0, 12000),
      actions: cleanLinks(data.actions, user, true),
      sources: cleanLinks(data.sources, user),
      mode: data.mode === "model" ? "model" : "guide",
    };
  }

  function destroy() {
    generation++;
    if (active) {
      active.controller?.abort();
      clearInterval(active.timer);
      active.cleanupViewport?.();
      active = null;
    }
    history = history.filter((message) => message.status !== "pending");
  }

  function reset() {
    destroy();
    owner = null;
    history = [];
    draft = "";
    nextId = 0;
  }

  const trimHistory = () => {
    if (history.length > MAX_MESSAGES)
      history.splice(0, history.length - MAX_MESSAGES);
  };
  const character = (className = "") =>
    `<div class="pk-character ${className}" data-pk-character="hello" aria-hidden="true">${Object.entries(
      artwork,
    )
      .map(
        ([state, asset]) =>
          `<img src="${asset.src}" width="${asset.size}" height="${asset.size}" alt="" data-pk-state="${state}">`,
      )
      .join("")}</div>`;

  function messageHTML(message) {
    if (message.role === "user") {
      return `<article class="pk-message pk-user" data-pk-message="${message.id}"><p class="pk-message-label">Вы</p><p class="pk-text">${h(message.content)}</p>${message.status === "failed" ? '<p class="pk-message-status">Ответ не получен</p>' : ""}</article>`;
    }
    return `<article class="pk-message pk-assistant" data-pk-message="${message.id}"><div class="pk-answer-heading"><img src="/assets/figma/kistik/reply-ready.svg" alt="" width="36" height="36"><span>Кистик</span>${message.mode === "guide" ? '<span class="pk-mode">Подсказка по сайту</span>' : ""}</div><p class="pk-text">${h(message.content)}</p>${message.actions?.length ? `<section class="pk-suggestion" aria-label="Предложенные действия"><h3>Следующий шаг</h3><div class="pk-actions">${message.actions.map((action, index) => `<a class="button ${index ? "secondary" : ""}" href="${h(action.href)}">${h(action.label)}</a>`).join("")}</div><p>Переход откроет раздел сайта. Данные профиля и заявки не изменятся.</p></section>` : ""}${message.sources?.length ? `<nav class="pk-sources" aria-label="Разделы, на которых основана подсказка"><span>Подробнее на сайте</span>${message.sources.map((source) => `<a href="${h(source.href)}">${h(source.label)} <span aria-hidden="true">↗</span></a>`).join("")}</nav>` : ""}</article>`;
  }

  function markup(user) {
    const staff = user && user.role !== "volunteer";
    return `<section class="pk-page" aria-labelledby="pk-title">
      <div class="pk-mobile-heading"><img src="/assets/figma/kistik/mobile-hello.svg" width="72" height="72" alt=""><div><strong>Кистик на связи</strong><span>ИИ-помощник «Детей Марии»</span></div></div>
      <header class="pk-heading"><h1 id="pk-title">${staff ? "Помогу освоиться на сайте" : '<span class="pk-desktop-title">Давайте найдём ваше дело</span><span class="pk-mobile-title">Найдём дело,<br>которое вам близко</span>'}</h1><p>${staff ? "Спросите, где найти нужный раздел и как выполнить задачу. Кистик подскажет следующий шаг." : "Расскажите, что вам интересно и когда удобно помогать. Кистик предложит следующий шаг."}</p></header>
      <div class="pk-layout">
        <aside class="pk-companion" aria-label="О помощнике"><p class="pk-kicker">Кистик · ИИ-помощник</p>${character()}<div class="pk-companion-copy"><h2>Рядом с первого шага</h2><p>Домовой нашей мастерской. Помогу освоиться, найти подходящий раздел и подготовиться к встрече.</p></div><ul class="pk-benefits">${(staff ? ["Найдём нужный раздел", "Разберём рабочие шаги", "Подскажу, где искать помощь"] : ["Найдём возможности на сайте", "Разберём вопросы анкеты", "Обсудим первые шаги"]).map((label) => `<li><img src="/assets/figma/kistik/check.svg" width="18" height="18" alt="">${label}</li>`).join("")}</ul><div class="pk-contact"><button type="button" class="button secondary" data-pk-contact>Связаться с командой</button><p>Важные вопросы об участии поможет уточнить команда фонда.</p></div></aside>
        <section class="pk-chat" aria-labelledby="pk-chat-title"><header class="pk-chat-heading"><div><h2 id="pk-chat-title">${staff ? "С чего начнём?" : "Начнём с ваших интересов"}</h2><p>Вы выбираете, какие предложения применить</p></div><button type="button" class="pk-clear" data-pk-clear ${history.length || draft ? "" : "hidden"}>Новый разговор</button></header>
          <div class="pk-mode-notice" data-pk-mode role="status">Подключаем помощника…</div>
          <div class="pk-prompts" aria-label="Быстрые вопросы" data-pk-prompts></div>
          <div class="pk-history" data-pk-history tabindex="0" role="log" aria-label="Разговор с Кистиком" aria-live="polite" aria-relevant="additions" aria-atomic="false">${history.length ? history.map(messageHTML).join("") : '<div class="pk-welcome" data-pk-welcome><p class="pk-kicker">Привет, я Кистик!</p><h3>Можно начать с простого вопроса</h3><p>Помогу с навигацией по сайту и первыми шагами. Опишите, что хотите сделать, или выберите быстрый вопрос выше.</p></div>'}</div>
          <button type="button" class="pk-new-answer" data-pk-new-answer hidden>К новому ответу ↓</button>
          <div class="pk-thinking" data-pk-thinking role="status" hidden><span aria-hidden="true">•••</span> Кистик готовит ответ…</div>
          <div class="pk-error" data-pk-error role="alert" hidden></div>
          <form class="pk-composer" data-pk-form><div class="pk-input-row"><label class="pk-input"><span>Сообщение</span><textarea name="message" rows="2" maxlength="1000" placeholder="Напишите, чем вам помочь" aria-describedby="pk-input-hint pk-limit" required disabled>${h(draft)}</textarea></label><button type="submit" class="pk-send" aria-label="Отправить сообщение" title="Отправить сообщение" disabled><img src="/assets/figma/kistik/send.svg" width="24" height="24" alt=""></button></div><div class="pk-input-meta"><span id="pk-input-hint"><span class="pk-keyboard-hint">Enter — отправить · Shift + Enter — новая строка</span><span class="pk-touch-hint">Нажмите стрелку, чтобы отправить</span></span><span id="pk-limit">${draft.length} / 1000</span></div><p class="pk-disclaimer">Кистик может ошибаться. Важные условия участия уточняйте у команды фонда.</p><p class="pk-memory">Разговор хранится только в этой вкладке. Для ответа учитываются последние 6 сообщений.</p></form>
          <div class="pk-mobile-contact"><button type="button" class="pk-contact-link" data-pk-contact>Связаться с командой фонда →</button></div>
        </section>
      </div>
    </section>`;
  }

  async function render(context) {
    destroy();
    const key = context.user
      ? `${context.user.id}:${context.user.role}`
      : "guest";
    if (key !== owner) {
      history = [];
      draft = "";
      owner = key;
    }
    const token = generation;
    if (context.set(markup(context.user)) === false) return;
    const root = document.querySelector(".pk-page");
    if (!root) return;
    const view = {
      root,
      controller: null,
      timer: null,
      pending: false,
      ready: false,
      enabled: true,
      retryAt: 0,
      maxLength: MAX_MESSAGE_LENGTH,
      maxHistory: MAX_HISTORY,
    };
    active = view;
    const current = () =>
      token === generation &&
      root.isConnected &&
      (!context.set.current || context.set.current());
    const log = root.querySelector("[data-pk-history]");
    const form = root.querySelector("[data-pk-form]");
    const input = form.elements.message;
    const send = form.querySelector("[type=submit]");
    const errorBox = root.querySelector("[data-pk-error]");
    const modeBox = root.querySelector("[data-pk-mode]");
    const newAnswer = root.querySelector("[data-pk-new-answer]");
    const clear = root.querySelector("[data-pk-clear]");
    const atBottom = () =>
      log.scrollHeight - log.clientHeight - log.scrollTop < 80;
    const scrollBottom = () => {
      log.scrollTop = log.scrollHeight;
      newAnswer.hidden = true;
    };
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const followBottom = atBottom();
      root.style.setProperty(
        "--pk-viewport-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      if (followBottom) scrollBottom();
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    window.addEventListener("resize", syncViewport);
    view.cleanupViewport = () => {
      viewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
    const setCharacter = (state) =>
      root.querySelectorAll("[data-pk-character]").forEach((element) => {
        element.dataset.pkCharacter = state;
      });
    const secondsLeft = () =>
      Math.max(0, Math.ceil((view.retryAt - Date.now()) / 1000));
    const controls = () => {
      const disabled =
        !view.ready || !view.enabled || view.pending || secondsLeft() > 0;
      input.disabled = !view.ready || !view.enabled || view.pending;
      send.disabled = disabled || !input.value.trim();
      root.querySelectorAll("[data-pk-prompt]").forEach((button) => {
        button.disabled = disabled;
      });
      const retry = errorBox.querySelector("[data-pk-retry]");
      if (retry) {
        retry.disabled = disabled;
        retry.textContent = secondsLeft()
          ? `Повторить через ${secondsLeft()} с`
          : "Повторить запрос";
      }
      clear.disabled = view.pending;
      clear.hidden = !history.length && !input.value;
      form.setAttribute("aria-busy", String(view.pending));
      root.querySelector("[data-pk-thinking]").hidden = !view.pending;
      root.querySelector("#pk-limit").textContent =
        `${input.value.length} / ${view.maxLength}`;
    };
    const hideError = () => {
      errorBox.hidden = true;
      errorBox.replaceChildren();
    };
    const showError = (text, retry = false) => {
      errorBox.innerHTML = `<p>${h(text)}</p>${retry ? '<button type="button" class="button secondary" data-pk-retry>Повторить запрос</button>' : ""}`;
      errorBox.hidden = false;
      controls();
    };
    const append = (message) => {
      const shouldScroll = atBottom();
      log.querySelector("[data-pk-welcome]")?.remove();
      log.insertAdjacentHTML("beforeend", messageHTML(message));
      const present = new Set(history.map((entry) => String(entry.id)));
      log.querySelectorAll("[data-pk-message]").forEach((entry) => {
        if (!present.has(entry.dataset.pkMessage)) entry.remove();
      });
      if (shouldScroll || message.role === "user") scrollBottom();
      else newAnswer.hidden = false;
    };

    async function loadConfig() {
      view.ready = false;
      controls();
      modeBox.textContent = "Подключаем помощника…";
      try {
        const data = await context.api("/assistant/config");
        if (!current()) return;
        view.enabled = data.enabled !== false;
        view.maxLength = Math.min(
          MAX_MESSAGE_LENGTH,
          Math.max(1, Number(data.max_message_length) || MAX_MESSAGE_LENGTH),
        );
        view.maxHistory = Math.min(
          MAX_HISTORY,
          Math.max(1, Number(data.max_history) || MAX_HISTORY),
        );
        input.maxLength = view.maxLength;
        const examples = (Array.isArray(data.examples) ? data.examples : [])
          .filter(
            (item) =>
              typeof item === "string" &&
              item.trim() &&
              item.length <= view.maxLength,
          )
          .slice(0, 4);
        root.querySelector("[data-pk-prompts]").innerHTML = examples
          .map(
            (label) =>
              `<button type="button" class="pk-prompt" data-pk-prompt="${h(label)}">${h(label)}</button>`,
          )
          .join("");
        modeBox.hidden = data.mode === "model" && view.enabled;
        modeBox.textContent = !view.enabled
          ? "Помощник сейчас недоступен. Можно связаться с командой фонда."
          : "Сейчас доступна справочная подсказка по сайту.";
        view.ready = true;
        controls();
      } catch (error) {
        if (!current()) return;
        modeBox.textContent = "Не удалось подключить помощника.";
        errorBox.innerHTML = `<p>${h(error.message || "Нет связи с сервером.")}</p><button type="button" class="button secondary" data-pk-reload>Повторить подключение</button>`;
        errorBox.hidden = false;
      }
    }

    async function submit() {
      if (
        !current() ||
        view.pending ||
        !view.ready ||
        !view.enabled ||
        secondsLeft()
      )
        return;
      const message = input.value.trim();
      if (!message || message.length > view.maxLength) {
        if (message.length > view.maxLength)
          showError(`Сократите сообщение до ${view.maxLength} символов.`);
        return;
      }
      const historyForRequest = history
        .filter((entry) => !entry.status && !entry.fallback)
        .slice(-view.maxHistory)
        .map(({ role, content }) => ({
          role,
          content: content.slice(0, MAX_MESSAGE_LENGTH),
        }));
      history = history.filter((entry) => entry.status !== "failed");
      const messageItem = {
        id: ++nextId,
        role: "user",
        content: message,
        status: "pending",
      };
      history.push(messageItem);
      trimHistory();
      draft = input.value;
      hideError();
      view.pending = true;
      view.controller = new AbortController();
      setCharacter("thinking");
      controls();
      append(messageItem);
      try {
        const currentRoute =
          safeHref(
            `#${
              String(context.page || "kistik")
                .replace(/^#/, "")
                .split(/[/?]/)[0]
            }`,
            context.user,
          ) || "#kistik";
        const result = await context.api("/assistant/chat", {
          method: "POST",
          body: JSON.stringify({
            message,
            history: historyForRequest,
            current_route: currentRoute,
          }),
          signal: view.controller.signal,
        });
        if (!current()) return;
        const reply = normalizeReply(result, context.user);
        if (!reply)
          throw new Error(
            "Кистик не смог подготовить ответ. Попробуйте ещё раз.",
          );
        delete messageItem.status;
        history.push(reply);
        trimHistory();
        input.value = "";
        draft = "";
        append(reply);
        setCharacter("ready");
        modeBox.hidden = reply.mode !== "guide";
        modeBox.textContent = "Сейчас доступна справочная подсказка по сайту.";
        const destination = safeHref(result.navigateTo, context.user);
        if (
          destination &&
          reply.actions.some((action) => action.href === destination)
        )
          context.onNavigate?.(destination);
      } catch (error) {
        if (!current()) return;
        if (error.status === 401 && context.user && context.onSessionExpired) {
          context.onSessionExpired();
          return;
        }
        messageItem.status = "failed";
        log
          .querySelector(`[data-pk-message="${messageItem.id}"]`)
          ?.insertAdjacentHTML(
            "beforeend",
            '<p class="pk-message-status">Ответ не получен</p>',
          );
        const fallback = normalizeReply(error.response, context.user);
        if (fallback) {
          fallback.fallback = true;
          history.push(fallback);
          trimHistory();
          append(fallback);
        }
        view.retryAt =
          Date.now() +
          Math.min(3600, Math.max(0, Number(error.retryAfter) || 0)) * 1000;
        setCharacter(fallback ? "ready" : "hello");
        if (error.code === "ASSISTANT_DISABLED") {
          view.enabled = false;
          modeBox.hidden = false;
          modeBox.textContent =
            "Помощник сейчас недоступен. Можно связаться с командой фонда.";
        }
        showError(
          error.message || "Не получилось получить ответ. Ваш текст сохранён.",
          view.enabled,
        );
        if (view.retryAt > Date.now()) {
          clearInterval(view.timer);
          view.timer = setInterval(() => {
            if (!current() || !secondsLeft()) clearInterval(view.timer);
            if (current()) controls();
          }, 1000);
        }
      } finally {
        if (current()) {
          view.pending = false;
          view.controller = null;
          controls();
          if (
            document.activeElement === send ||
            document.activeElement === document.body
          )
            input.focus({ preventScroll: true });
        }
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    input.addEventListener("input", () => {
      draft = input.value;
      controls();
    });
    input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches
      ) {
        event.preventDefault();
        submit();
      }
    });
    log.addEventListener("scroll", () => {
      if (atBottom()) newAnswer.hidden = true;
    });
    root.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button || button.disabled || !current()) return;
      if (button.hasAttribute("data-pk-prompt")) {
        input.value = button.dataset.pkPrompt;
        draft = input.value;
        controls();
        input.focus();
      } else if (button.hasAttribute("data-pk-retry")) submit();
      else if (button.hasAttribute("data-pk-reload")) {
        hideError();
        loadConfig();
      } else if (button.hasAttribute("data-pk-new-answer")) scrollBottom();
      else if (button.hasAttribute("data-pk-clear")) {
        history = [];
        draft = "";
        render(context);
      } else if (button.hasAttribute("data-pk-contact")) {
        button.disabled = true;
        try {
          await context.onContact?.();
        } catch (error) {
          if (current())
            showError(error.message || "Не удалось открыть чат с командой.");
        } finally {
          if (current()) button.disabled = false;
        }
      }
    });
    if (history.length) {
      scrollBottom();
      setCharacter("ready");
    }
    await loadConfig();
  }

  window.PortalKistik = { render, destroy, reset };
})();
