"use strict";

window.PortalAchievements = (() => {
  const rarities = {
    common: "Обычное",
    uncommon: "Необычное",
    rare: "Редкое",
    epic: "Эпическое",
    legendary: "Легендарное",
  };
  const drawings = {
    spark:
      '<path d="m16 3 3.5 8.5L28 15l-8.5 3.5L16 27l-3.5-8.5L4 15l8.5-3.5Z"/><path d="M25 3v5M22.5 5.5h5"/>',
    book: '<path d="M16 8c-4-3-8-3-12-1v19c4-2 8-2 12 1 4-3 8-3 12-1V7c-4-2-8-2-12 1Z"/><path d="M16 8v19M8 11l4 1M8 16l4 1M20 12l4-1M20 17l4-1"/>',
    people:
      '<circle cx="16" cy="10" r="4"/><path d="M9 27v-4a7 7 0 0 1 14 0v4M6 7a4 4 0 0 0 0 8M26 7a4 4 0 0 1 0 8M6 19a5 5 0 0 0-4 5v3M26 19a5 5 0 0 1 4 5v3"/>',
    hands:
      '<path d="M3 17v7l7 5h12l7-5v-7a2 2 0 0 0-4 0v3l-4 3H11l-4-3v-3a2 2 0 0 0-4 0Z"/><path d="M16 18s-7-4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5-7 9-7 9Z"/>',
    heart:
      '<path d="M16 27S3 19 3 10a7 7 0 0 1 13-3 7 7 0 0 1 13 3c0 9-13 17-13 17Z"/><path d="m10 15 4 4 8-9"/>',
  };
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const list = (value) => (Array.isArray(value?.items) ? value.items : []);
  const rarity = (value) => (Object.hasOwn(rarities, value) ? value : "common");
  const awardedDate = (value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "Дата не указана";
  };
  const symbol = (name) =>
    `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${Object.hasOwn(drawings, name) ? drawings[name] : drawings.spark}</svg>`;
  const slot = (className = "card") =>
    `<section class="${className} achievement-section" data-achievements aria-label="Достижения"><h2>Достижения</h2><p class="muted" role="status">Загружаем достижения…</p></section>`;
  function badge(
    item,
    { earned = true, compact = false, manage = false } = {},
  ) {
    const tone = rarity(item.rarity);
    // Labels come from the API; only known rarity classes and local SVG paths enter markup.
    return `<li class="achievement-card achievement-${tone} ${earned ? "is-earned" : "is-locked"} ${compact ? "is-compact" : ""}" data-achievement-id="${escape(item.achievement_id || item.id)}"><span class="achievement-symbol">${symbol(item.icon)}</span><div class="achievement-body"><h3>${escape(item.title)}</h3><span class="achievement-rarity">${rarities[tone]}</span>${compact ? "" : `<p>${escape(item.description)}</p>`}<p class="achievement-state">${earned ? `Получено · ${escape(awardedDate(item.awarded_at))}` : "Пока не получено"}</p>${manage ? `<button class="achievement-revoke text-link" type="button" data-revoke-achievement="${escape(item.achievement_id)}">Отменить выдачу</button>` : ""}</div></li>`;
  }
  function mount({
    element,
    api,
    mode = "compact",
    userId,
    canManage = false,
    canGrant = true,
  }) {
    if (!element) return;
    const path = userId
      ? `/users/${encodeURIComponent(userId)}/achievements`
      : "/me/achievements";
    const managed = mode === "manage" && canManage;
    let awards = [],
      catalog = [],
      sequence = 0,
      busy = false;
    const current = (token) => element.isConnected && token === sequence;
    function draw(status = "") {
      if (!element.isConnected) return;
      const owned = new Map(
        awards.map((item) => [String(item.achievement_id), item]),
      );
      const available = catalog.filter((item) => !owned.has(String(item.id)));
      element.innerHTML = `<div class="section-heading"><h2>Достижения</h2><span class="achievement-count">${awards.length}${mode === "collection" ? ` / ${catalog.length}` : ""}</span></div>${mode === "collection" ? '<p class="muted">Небольшие знаки благодарности за ваш вклад. Достижения вручает администратор фонда — они не начисляются автоматически.</p><h3 class="achievement-subtitle">Полученные</h3>' : ""}${awards.length ? `<ul class="achievement-list ${mode !== "collection" ? "achievement-list-compact" : ""}">${awards.map((item) => badge(item, { compact: true, manage: managed })).join("")}</ul>` : '<p class="muted achievement-empty">Пока нет полученных достижений. Их вручает администратор фонда.</p>'}${mode === "collection" ? `<h3 class="achievement-subtitle">Вся коллекция</h3><ul class="achievement-list achievement-catalog">${catalog.map((item) => badge({ ...item, ...owned.get(String(item.id)) }, { earned: owned.has(String(item.id)) })).join("")}</ul>` : ""}${mode === "compact" && !userId ? '<a class="text-link" href="#participation">Посмотреть коллекцию в «Моём вкладе» →</a>' : ""}${managed ? (!canGrant ? '<p class="muted">Новое достижение можно выдать только действующему профилю волонтёра.</p>' : available.length ? `<form class="achievement-grant-form"><label class="field"><span>Выберите достижение</span><select name="achievement_id" required><option value="">Выбрать из коллекции</option>${available.map((item) => `<option value="${escape(item.id)}">${escape(item.title)} · ${rarities[rarity(item.rarity)]}</option>`).join("")}</select></label><p class="muted small">Награда появится в личном профиле и в разделе «Мой вклад» волонтёра.</p><button class="button" type="submit">Выдать достижение</button></form>` : '<p class="muted">Все достижения коллекции уже выданы.</p>') : ""}<div data-achievement-confirm></div><p class="form-error" data-achievement-error role="alert"></p><p class="achievement-feedback" role="status">${escape(status)}</p>`;
      const form = element.querySelector(".achievement-grant-form");
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = Number(form.elements.achievement_id.value);
        if (
          !canGrant ||
          !id ||
          !available.some((item) => Number(item.id) === id)
        )
          return;
        void mutate(
          () =>
            api(path, {
              method: "POST",
              body: JSON.stringify({ achievement_id: id }),
            }),
          "Достижение выдано.",
        );
      });
      element
        .querySelectorAll("[data-revoke-achievement]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            if (busy) return;
            const item = owned.get(button.dataset.revokeAchievement);
            if (!item) return;
            const confirmation = element.querySelector(
              "[data-achievement-confirm]",
            );
            confirmation.innerHTML = `<div class="achievement-confirm" role="group" aria-label="Подтверждение отмены выдачи"><p>Отменить выдачу «${escape(item.title)}»? Достижение исчезнет из профиля волонтёра. При необходимости его можно выдать снова.</p><div class="actions"><button class="button secondary" type="button" data-cancel-revoke>Оставить достижение</button><button class="button" type="button" data-confirm-revoke>Да, отменить выдачу</button></div></div>`;
            confirmation
              .querySelector("[data-cancel-revoke]")
              .addEventListener("click", () => {
                confirmation.replaceChildren();
                button.focus();
              });
            confirmation
              .querySelector("[data-confirm-revoke]")
              .addEventListener("click", () => {
                void mutate(
                  () =>
                    api(`${path}/${encodeURIComponent(item.achievement_id)}`, {
                      method: "DELETE",
                    }),
                  "Выдача достижения отменена.",
                );
              });
            confirmation.querySelector("[data-cancel-revoke]").focus();
          });
        });
    }
    async function load(status = "") {
      const token = ++sequence;
      try {
        const [received, all] = await Promise.all([
          api(path),
          mode === "collection" || managed
            ? api("/achievements")
            : Promise.resolve({ items: [] }),
        ]);
        // A response for a profile left behind must not redraw a newer page.
        if (!current(token)) return;
        awards = list(received);
        catalog = list(all);
        draw(status);
      } catch (error) {
        if (!current(token)) return;
        element.innerHTML =
          '<h2>Достижения</h2><p class="form-error" role="alert"></p><button class="button secondary" type="button">Повторить загрузку</button>';
        element.querySelector(".form-error").textContent =
          error.message || "Не удалось загрузить достижения.";
        element
          .querySelector("button")
          .addEventListener("click", () => void load(status));
      }
    }
    async function mutate(action, message) {
      if (busy || !managed || !element.isConnected) return;
      busy = true;
      element.querySelectorAll("button,select").forEach((control) => {
        control.disabled = true;
      });
      element.querySelector("[data-achievement-error]").textContent = "";
      try {
        const result = await action();
        if (!element.isConnected) return;
        await load(result?.duplicate ? "Это достижение уже выдано." : message);
      } catch (error) {
        if (element.isConnected)
          element.querySelector("[data-achievement-error]").textContent =
            error.message || "Не удалось сохранить изменение.";
      } finally {
        busy = false;
        if (element.isConnected)
          element.querySelectorAll("button,select").forEach((control) => {
            control.disabled = false;
          });
      }
    }
    void load();
  }
  return { slot, mount };
})();
