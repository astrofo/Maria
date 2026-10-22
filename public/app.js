"use strict";

const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const toastBox = document.querySelector("#toast");
const state = {
  user: null,
  config: {},
  csrf: null,
  route: "opportunities",
  page: 1,
  usersFilter: {},
  listViews: {},
  notificationsPage: 1,
  notificationsUnreadOnly: false,
  events: new Map(),
  participation: new Map(),
  view: 0,
};
const roleLabels = {
  volunteer: "Волонтёр",
  coordinator: "Координатор",
  manager: "Руководитель",
  admin: "Администратор",
};
const statusLabels = {
  open: "Открыто",
  draft: "Черновик",
  closed: "Закрыто",
  pending: "На рассмотрении",
  accepted: "Подтверждён",
  rejected: "Отклонён",
  withdrawn: "Отозван",
  new: "Новый",
  active: "Активен",
  paused: "Пауза",
};
const staff = () => state.user && state.user.role !== "volunteer";
const manager = () =>
  state.user && ["manager", "admin"].includes(state.user.role);
const admin = () => state.user?.role === "admin";
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const h = escapeHTML;
const list = (value) => (Array.isArray(value) ? value : []);
const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const idsEqual = (a, b) => String(a) === String(b);
const dateOnly = (value) => (value ? String(value).slice(0, 10) : "");
const date = (value, withTime = false) => {
  if (!value) return "Не указана";
  const input = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? `${value}T12:00:00`
    : value;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime())
    ? "Не указана"
    : parsed.toLocaleString(
        "ru-RU",
        withTime
          ? {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }
          : { day: "numeric", month: "long", year: "numeric" },
      );
};
const localDateTime = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const initials = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
const safeURL = (value) => {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, location.origin);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};
const statusPill = (value) =>
  `<span class="pill ${h(value)}">${h(statusLabels[value] || value)}</span>`;
const tags = (values) =>
  list(values)
    .map((value) => `<span class="pill">${h(value)}</span>`)
    .join("");
const empty = (title, description = "") =>
  `<div class="empty"><strong>${h(title)}</strong><p>${h(description)}</p></div>`;
// Labels can come from organizer-authored notifications; render them as text.
const button = (label, action, data = "", secondary = false) =>
  `<button type="button" class="button ${secondary ? "secondary" : ""}" data-action="${h(action)}" ${data}>${h(label)}</button>`;
const iconPaths = {
  opportunities:
    '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16"/>',
  applications:
    '<path d="m8 12 3 3 6-7"/><rect x="4" y="3" width="16" height="18" rx="3"/>',
  training: '<path d="m2 9 10-5 10 5-10 5-10-5Zm4 2v6l6 3 6-3v-6m4-2v7"/>',
  participation: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 5v2"/>',
  analytics: '<path d="M4 20V9m8 11V4m8 16v-7M2 20h20"/>',
  notifications:
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12a2 2 0 0 0 4 0"/>',
  thanks:
    '<path d="M12 21S3 15 3 8a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 7-9 13-9 13Z"/>',
  questionnaire:
    '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  profile:
    '<circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/>',
  audit: '<path d="M12 3 3 7v5c0 5 9 10 9 10s9-5 9-10V7L12 3Zm-4 9 3 3 5-6"/>',
};
const figmaAsset = (name) => `/assets/figma/${name}`;
const figmaIcons = {
  dashboard: "22169.svg",
  opportunities: "416a9.svg",
  training: "9dade.svg",
  participation: "b5b8e.svg",
  kistik: "light-20261022/2650c.svg",
  messages: "light-20261022/5cfa4.svg",
  "staff-tasks": "organizer/4d5d9.svg",
  access: "organizer/5ae46.svg",
  notifications: "ad68a.svg",
  notificationsActive: "24929.svg",
  arrow: "098e5.svg",
  check: "4af9f.svg",
  location: "cc6fc.svg",
  clock: "11b27.svg",
  team: "22455.svg",
  mail: "0ea77.svg",
  calendar: "aa759.svg",
  confirmed: "e9412.svg",
  menu: "36a8e.svg",
};
const icon = (name) =>
  figmaIcons[name]
    ? `<span class="figma-icon" aria-hidden="true"><img src="${figmaAsset(figmaIcons[name])}" alt=""></span>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.opportunities}</svg>`;
const brand = (publicView = false) =>
  `<a class="brand" href="#home" aria-label="Дети Марии — главная">${publicView ? `<picture><source media="(max-width: 767px)" srcset="${figmaAsset("logo-mobile.svg")}"><img src="${figmaAsset("light-20261022/eeaae.svg")}" alt="Дети Марии"></picture>` : `<img src="${figmaAsset("light-20261022/aa920.svg")}" alt="Дети Марии">`}</a>`;
function demoEmailAccount(user = state.user) {
  return user?.email_demo_account === true;
}
function loginCodeAvailable() {
  return (
    state.config.email_login_available === true ||
    state.config.email_demo_login_available === true
  );
}
function loginChallenge(result, email) {
  const demo = result.delivery === "demo" && result.demo_code === "1234";
  return {
    email: result.email || email,
    delivery: demo ? "demo" : "email",
    demo_code: demo ? "1234" : undefined,
    resendAt: Date.now() + number(result.resend_after || 30) * 1000,
    expiresAt: Date.now() + number(result.expires_in || 600) * 1000,
  };
}
function demoLoginChallenge(pending = state.loginVerification) {
  return pending?.delivery === "demo" && pending.demo_code === "1234";
}
function demoAccessNotice() {
  return demoEmailAccount()
    ? `<div class="demo-access-banner" role="note"><strong>Тестовый аккаунт</strong><span>Для входа в этот аккаунт доступен код <b>1234</b>. Он не подтверждает владение почтой. Используйте тестовые данные.</span></div>`
    : "";
}
function publicHeader() {
  const home = !location.hash || location.hash === "#home";
  const join = state.user ? "#questionnaire" : "#register";
  return `<header class="public-header">${brand(true)}<nav id="public-navigation" class="public-nav" aria-label="Основная навигация"><a href="#home" data-action="home-section" data-section="about">О фонде</a><a href="#home" data-action="home-section" data-section="directions">Возможности</a><a href="#home" data-action="home-section" data-section="start">Как начать</a><a class="public-mobile-link" href="#kistik">Кистик · помощник</a><a class="public-mobile-link" href="${join}">${state.user ? "Моя анкета" : "Стать волонтёром"}</a><button class="public-mobile-link" type="button" data-action="open-chat">Чат с фондом</button></nav><a href="#kistik" class="public-kistik-link">Кистик · помощник</a><div class="public-account-slot"><a class="button secondary public-login" href="${state.user ? "#dashboard" : "#login"}">${state.user ? "Мой кабинет" : "Войти"}</a>${home ? `<a class="button header-join cta-hidden" href="${join}" tabindex="-1" aria-hidden="true">Присоединиться</a>` : ""}</div>${home ? '<button type="button" class="button secondary public-chat" data-action="open-chat">Чат с фондом</button>' : ""}<button type="button" class="public-menu" data-action="public-menu" aria-label="Открыть меню" aria-controls="public-navigation" aria-expanded="false">${icon("menu")}</button></header>${demoAccessNotice()}`;
}
function policyLinks() {
  return [
    [state.config.rules_url, "Правила пользования сайтом"],
    [state.config.privacy_url, "Политика обработки персональных данных"],
  ]
    .filter(([url]) => safeURL(url))
    .map(
      ([url, label]) =>
        `<a href="${h(safeURL(url))}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`,
    )
    .join("");
}
function publicFooter() {
  return `<footer class="public-footer"><div class="footer-brand">${brand()}<p>Творчество объединяет.<br>Люди меняют жизнь.</p></div><a class="button" href="${state.user ? "#questionnaire" : "#register"}">Стать частью команды</a><div class="public-policy-links">${policyLinks()}</div></footer>`;
}

class APIError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.code = data.code;
    this.details = data.details;
    this.retryAfter = data.retry_after;
    this.response = data;
  }
}
async function refreshCSRF() {
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok)
    throw new APIError(
      "Не удалось открыть защищённую сессию. Попробуйте ещё раз.",
      response.status,
    );
  const data = await response.json();
  state.csrf = data.csrfToken;
}
async function api(path, options = {}) {
  const method = options.method || "GET";
  if (method !== "GET" && !state.csrf) await refreshCSRF();
  let response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(method !== "GET" ? { "X-CSRF-Token": state.csrf } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new APIError(
      "Нет связи с сервером. Проверьте подключение и повторите действие.",
      0,
    );
  }
  const data =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok)
    throw new APIError(
      data?.error || `Сервер не смог выполнить запрос (${response.status}).`,
      response.status,
      data || {},
    );
  if (data?.csrfToken) state.csrf = data.csrfToken;
  return data;
}
const write = (path, body = {}, method = "POST") =>
  api(path, { method, body: JSON.stringify(body) });
function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  toastBox.textContent = message;
  toastBox.className = `toast${error ? " error" : ""}`;
  toastBox.hidden = false;
  state.toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, 5000);
}
function errorHTML(error) {
  return `<div class="notice error" role="alert">${h(error.message)}</div>`;
}
function field(
  label,
  name,
  value = "",
  type = "text",
  required = false,
  extra = "",
) {
  return `<div class="field"><label for="${h(name)}">${label}</label><input id="${h(name)}" name="${h(name)}" type="${type}" value="${h(value)}" ${required ? "required" : ""} ${extra}></div>`;
}
function textarea(label, name, value = "", required = false, max = 4000) {
  return `<div class="field"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" ${required ? "required" : ""} maxlength="${max}">${h(value)}</textarea></div>`;
}
function select(
  label,
  name,
  options,
  value = "",
  required = false,
  extra = "",
) {
  return `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}" ${required ? "required" : ""} ${extra}>${options.map(([key, title]) => `<option value="${h(key)}" ${idsEqual(key, value) ? "selected" : ""}>${h(title)}</option>`).join("")}</select></div>`;
}
const check = (label, name, checked = false, required = false) =>
  `<label class="check"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${required ? "required" : ""}><span>${label}</span></label>`;
const formEnd = (label = "Сохранить") =>
  `<div class="form-error" role="alert"></div><div class="form-actions"><button type="submit" class="button">${label}</button></div>`;
function showFormError(form, error) {
  const errorBox = form?.querySelector(".form-error");
  if (!errorBox) {
    toast(error.message, true);
    return;
  }
  errorBox.textContent = error.message;
  const loginForm =
    ["email-code", "password"].includes(form.dataset.authMode) ||
    form.id === "login-verification-form";
  if (error.code === "account_not_found" && loginForm) {
    const registrationLink = document.createElement("a");
    registrationLink.href = "#register";
    registrationLink.className = "text-link";
    registrationLink.textContent = "Зарегистрироваться →";
    registrationLink.addEventListener("click", () => {
      const emailInput = form.elements.email || form.elements.login_code_email;
      const email = emailInput?.value.trim() || state.loginEmail || "";
      state.loginEmail = email;
      state.registrationDraft = { ...state.registrationDraft, email };
    });
    const action = document.createElement("p");
    action.append(registrationLink);
    errorBox.append(action);
  }
  if (
    error.code === "required_course_incomplete" &&
    /^\d+$/.test(String(error.response?.required_course_id))
  ) {
    const courseLink = document.createElement("a");
    courseLink.className = "text-link";
    courseLink.href = `#training/course/${error.response.required_course_id}`;
    courseLink.textContent = "Открыть обязательный курс →";
    const action = document.createElement("p");
    action.append(courseLink);
    errorBox.append(action);
  }
  errorBox.scrollIntoView({ block: "nearest" });
}
function restoreLoginError(form) {
  if (!state.loginError) return;
  const error = state.loginError;
  state.loginError = null;
  showFormError(form, error);
}
function bindForm(form, handler) {
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.pending) return;
    const submit = event.submitter || form.querySelector('[type="submit"]');
    const buttons = [...form.querySelectorAll('[type="submit"]')].map(
      (button) => [button, button.disabled],
    );
    const errorBox = form.querySelector(".form-error");
    if (errorBox) errorBox.textContent = "";
    form.dataset.pending = "true";
    const submitLabel = submit?.textContent;
    buttons.forEach(([button]) => (button.disabled = true));
    if (submit) {
      if (submit.dataset.pendingLabel)
        submit.textContent = submit.dataset.pendingLabel;
    }
    try {
      await handler(new FormData(form), form);
    } catch (error) {
      if (!form.isConnected) return;
      if (error.status === 401 && state.user) return expiredSession();
      showFormError(form, error);
    } finally {
      delete form.dataset.pending;
      buttons.forEach(([button, disabled]) => (button.disabled = disabled));
      if (submit) {
        if (submitLabel != null) submit.textContent = submitLabel;
      }
    }
  });
}
function openDialog(title, content, handler, submitLabel = "Сохранить") {
  if (!state.user)
    throw new APIError("Войдите в кабинет, чтобы продолжить.", 401);
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${h(title)}</h2><button type="button" class="close-button" data-action="close-dialog" aria-label="Закрыть">×</button></div>${handler ? `<form id="dialog-form">${content}<div class="form-error" role="alert"></div><div class="form-actions"><button type="button" class="button secondary" data-action="close-dialog">Отмена</button><button type="submit" class="button">${h(submitLabel)}</button></div></form>` : content}`;
  dialog.showModal();
  if (handler) bindForm(dialog.querySelector("form"), handler);
}
function header(title, description, action = "") {
  return `<div class="page-heading"><div><h1>${h(title)}</h1>${description ? `<p class="muted">${h(description)}</p>` : ""}</div>${action}</div>`;
}

function navigate(route) {
  if (location.hash === `#${route}`) return;
  else location.hash = route;
}
function clearModuleState() {
  window.DMMessaging?.destroy();
  window.PortalCommunity?.destroy();
  window.PortalOrganizer?.reset();
  window.PortalCourses?.reset?.();
  window.PortalKistik?.reset();
  state.kistikOrigin = null;
  state.currentViewRoute = null;
  // In-memory records and filters must not carry over to another signed-in user.
  state.events.clear();
  state.participation.clear();
  state.listViews = {};
  state.usersFilter = {};
  state.page = 1;
  state.notificationsPage = 1;
  state.notificationsUnreadOnly = false;
  PortalUI.clearGuard();
}
function expiredSession() {
  ++state.view;
  clearModuleState();
  state.user = null;
  state.csrf = null;
  if (dialog.open) dialog.close();
  renderAuth(false, "Сессия закончилась. Войдите снова, чтобы продолжить.");
}

function authLayout(content) {
  return `<div class="public-page auth-page">${publicHeader()}<main id="content" class="auth-panel"><div class="auth-form">${content}</div><div class="auth-policy-links">${policyLinks()}</div></main></div>`;
}

function renderLogin(info = "") {
  if (window.PortalAccounts) return PortalAccounts.renderLogin(info);
  state.view++;
  clearInterval(state.verificationTimer);
  clearInterval(state.loginVerificationTimer);
  const mailAvailable = state.config.email_login_available === true;
  const canCode = loginCodeAvailable();
  const passwordMode = state.loginMode === "password" || !canCode;
  const email = state.loginEmail || state.loginVerification?.email || "";
  app.innerHTML = authLayout(
    `<div class="section-kicker">ПРОСТРАНСТВО ВОЛОНТЁРА</div><h1>Войти в кабинет</h1><p class="muted">${passwordMode ? "Введите почту и пароль от вашего кабинета." : mailAvailable ? "Введите почту существующего аккаунта. Для входа нужен четырёхзначный код." : "Введите почту тестового аккаунта, чтобы продолжить вход по коду."}</p>${info ? `<div class="notice" role="status">${h(info)}</div>` : ""}${!mailAvailable ? `<div class="notice" role="status">${canCode ? "Отправка писем сейчас недоступна. Вход по коду доступен только для тестовых аккаунтов. Для остальных используйте пароль." : "Вход по коду сейчас недоступен. Вы можете войти с паролем."}</div>` : ""}<form id="auth-form" data-auth-mode="${passwordMode ? "password" : "email-code"}">${field("Электронная почта", "email", email, "email", true, 'autocomplete="email" maxlength="254" placeholder="name@example.org"')}${passwordMode ? field("Пароль", "password", "", "password", true, 'autocomplete="current-password" maxlength="128"') : `<p class="muted small">${mailAvailable ? "Без пароля. Только код из письма." : "Код для тестового аккаунта появится на следующем шаге."}</p>`}<div class="form-error" role="alert"></div><button type="submit" class="button submit">${passwordMode ? "Войти" : "Получить код"}</button></form>${canCode ? `<div class="login-method"><button type="button" class="button ghost" data-action="login-method" data-mode="${passwordMode ? "code" : "password"}">${passwordMode ? "Войти по коду" : "Войти с паролем"}</button></div>` : ""}<div class="auth-switch"><p>Ещё не с нами?</p><button type="button" data-action="register-view">Зарегистрироваться →</button></div><div class="auth-switch"><button type="button" data-action="verify-view">Подтвердить почту после регистрации</button></div>`,
  );
  const form = document.querySelector("#auth-form");
  const viewToken = state.view;
  const hash = location.hash;
  restoreLoginError(form);
  bindForm(form, async (data) => {
    const address = data.get("email").trim();
    state.loginEmail = address;
    if (passwordMode) {
      const result = await write("/auth/login", {
        email: address,
        password: data.get("password"),
      });
      if (
        !form.isConnected ||
        state.view !== viewToken ||
        location.hash !== hash
      )
        return;
      if (!result.user)
        throw Error("Не удалось завершить вход. Попробуйте снова.");
      await finishLogin(result, state.afterLogin || "dashboard");
      return;
    }
    const result = await write("/auth/login-code/request", { email: address });
    if (!form.isConnected || state.view !== viewToken || location.hash !== hash)
      return;
    state.loginVerification = loginChallenge(result, address);
    navigate("login-code");
  });
}
function renderLoginCode(info = "") {
  if (!state.loginVerification?.email) {
    state.loginMode = "code";
    navigate("login");
    return;
  }
  state.view++;
  clearInterval(state.verificationTimer);
  clearInterval(state.loginVerificationTimer);
  const pending = state.loginVerification || {
    email: state.loginEmail || "",
    resendAt: 0,
    expiresAt: 0,
  };
  state.loginVerification = pending;
  const demo = demoLoginChallenge(pending);
  const mailAvailable =
    state.config.email_login_available === true ||
    (demo && state.config.email_demo_login_available === true);
  app.innerHTML = authLayout(
    `<div class="section-kicker">ВХОД ПО КОДУ</div><h1>${demo ? "Введите код" : "Проверьте почту"}</h1><p class="muted">${demo ? `Для входа в этот тестовый аккаунт введите код <strong>${h(pending.demo_code)}</strong>.` : `Запрос на отправку кода на <strong>${h(pending.email)}</strong> принят. Письмо может прийти не сразу.`}</p>${info ? `<div class="notice" role="status">${h(info)}</div>` : ""}${!mailAvailable ? '<div class="notice">Повторная отправка сейчас недоступна. Уже полученный код можно ввести ниже.</div>' : ""}<form id="login-verification-form" data-verification-mode="login">${field("Электронная почта", "login_code_email", pending.email, "email", true, 'autocomplete="email" maxlength="254" readonly')}${otpField(demo)}<p class="muted small">Код действует 10 минут с момента запроса.</p><div id="login-code-expiry" class="muted small" role="status"></div><div class="form-error" role="alert"></div><button type="submit" class="button submit">Войти</button></form><div class="login-method"><button type="button" class="button ghost" data-action="login-view">Изменить адрес почты</button></div><div class="verification-resend"><button type="button" class="button secondary" data-action="resend-login-code" ${!mailAvailable ? "disabled" : ""}>${demo ? "Запросить код снова" : "Отправить код повторно"}</button><span id="login-code-countdown" class="muted small" aria-live="polite"></span><p class="muted small">${demo ? "Введите 1234 в том же браузере, где начали вход. Код не подтверждает владение почтой." : "Если письма нет, проверьте папку «Спам». Введите код в том же браузере, где его запросили."}</p></div><div class="login-method"><button type="button" class="button ghost" data-action="login-method" data-mode="password">Войти с паролем</button></div>`,
  );
  const updateTimer = () => {
    const resend = document.querySelector('[data-action="resend-login-code"]'),
      countdown = document.querySelector("#login-code-countdown"),
      expiry = document.querySelector("#login-code-expiry");
    if (!resend || !countdown || !expiry) {
      clearInterval(state.loginVerificationTimer);
      return;
    }
    const seconds = Math.max(
      0,
      Math.ceil((pending.resendAt - Date.now()) / 1000),
    );
    resend.disabled =
      !mailAvailable || seconds > 0 || Boolean(state.loginVerificationSending);
    countdown.textContent = seconds
      ? `${demo ? "Запросить снова" : "Отправить снова"} через ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "";
    expiry.textContent =
      pending.expiresAt && pending.expiresAt <= Date.now()
        ? "Срок действия кода истёк. Запросите новый код."
        : "";
  };
  bindOTP("#login-verification-form");
  updateTimer();
  state.loginVerificationTimer = setInterval(updateTimer, 1000);
  const viewToken = state.view;
  const hash = location.hash;
  bindForm(
    document.querySelector("#login-verification-form"),
    async (data, form) => {
      const code = data.get("verification_code");
      if (!/^[0-9]{4}$/.test(code))
        throw Error(
          demo
            ? "Введите код тестового аккаунта 1234."
            : "Введите 4 цифры кода из письма.",
        );
      const result = await write("/auth/login-code/verify", {
        email: data.get("login_code_email").trim(),
        code,
      });
      // A completed request must not reopen a screen the user has already left.
      if (
        !form.isConnected ||
        state.view !== viewToken ||
        location.hash !== hash
      )
        return;
      if (!result.user)
        throw Error("Не удалось завершить вход. Попробуйте снова.");
      await finishLogin(result, state.afterLogin || "dashboard");
    },
  );
}
async function resendLoginCode() {
  if (state.loginVerificationSending) return;
  const input = document.querySelector("#login_code_email");
  if (!input?.reportValidity()) return;
  const form = input.closest("form");
  const viewToken = state.view;
  const email = input.value.trim();
  state.loginVerificationSending = true;
  try {
    const result = await write("/auth/login-code/request", {
      email,
    });
    if (!form.isConnected || state.view !== viewToken) return;
    state.loginVerification = loginChallenge(result, email);
    renderLoginCode(
      demoLoginChallenge()
        ? "Код запрошен. Для входа используйте 1234."
        : "Повторный запрос на отправку кода принят. Дождитесь письма и используйте последний код.",
    );
  } catch (error) {
    if (!form.isConnected || state.view !== viewToken) return;
    if (["account_not_found", "account_unavailable"].includes(error.code)) {
      state.loginEmail = email;
      state.loginVerification = null;
      state.loginError = error;
      clearInterval(state.loginVerificationTimer);
      navigate("login");
      return;
    }
    if (error.retryAfter)
      state.loginVerification.resendAt =
        Date.now() + number(error.retryAfter) * 1000;
    showFormError(form, error);
  } finally {
    state.loginVerificationSending = false;
  }
}
function renderAuth(register = false, info = "") {
  if (window.PortalAccounts)
    return register
      ? PortalAccounts.renderRegistration(info)
      : PortalAccounts.renderLogin(info);
  if (!register) return renderLogin(info);
  state.view++;
  clearInterval(state.loginVerificationTimer);
  clearInterval(state.verificationTimer);
  const privacy = safeURL(state.config.privacy_url);
  const rules = safeURL(state.config.rules_url);
  const allowed = state.config.registration_enabled === true;
  const mailAvailable = state.config.email_verification_available === true;
  const canRegister = allowed && mailAvailable;
  const unavailable = !allowed
    ? "Регистрация временно недоступна. Попробуйте позже или обратитесь к координатору фонда."
    : "Отправка кодов подтверждения пока недоступна. Попробуйте позже или обратитесь к координатору фонда.";
  app.innerHTML = authLayout(
    `<div class="section-kicker">ПРОСТРАНСТВО ВОЛОНТЁРА</div><h1>Давайте знакомиться</h1><p class="muted">Создайте профиль, чтобы стать волонтёром. Для регистрации нужно подтвердить почту кодом из письма.</p>${info ? `<div class="notice" role="status">${h(info)}</div>` : ""}${!canRegister ? `<div class="notice" role="status">${unavailable}</div>` : ""}<form id="auth-form" data-auth-mode="registration">${field("Как вас зовут", "full_name", "", "text", true, 'autocomplete="name" minlength="2" maxlength="120"')}<div class="form-grid">${select(
      "Пол (необязательно)",
      "gender",
      [
        ["unspecified", "Предпочитаю не указывать"],
        ["female", "Женский"],
        ["male", "Мужской"],
      ],
      "unspecified",
    )}${field("Город", "city", "", "text", false, 'autocomplete="address-level2" maxlength="120"')}${field("Дата рождения", "birth_date", "", "date", false, `max="${today()}" min="1900-01-01"`)}</div>${field("Электронная почта", "email", state.registrationDraft?.email || state.loginEmail || "", "email", true, 'autocomplete="email" maxlength="254"')}${field("Пароль", "password", "", "password", true, 'autocomplete="new-password" minlength="12" maxlength="128"')}${field("Повторите пароль", "repeat_password", "", "password", true, 'autocomplete="new-password" minlength="12" maxlength="128"')}<p class="muted small">Не менее 12 символов. Пароль пригодится для запасного способа входа.</p>${check(`Я принимаю ${rules ? `<a href="${h(rules)}" target="_blank" rel="noopener">правила пользования сайтом</a>` : "правила пользования сайтом"}`, "rules_accepted", false, true)}${check(`Я ознакомился(-ась) с ${privacy ? `<a href="${h(privacy)}" target="_blank" rel="noopener">политикой обработки персональных данных</a>` : "политикой обработки персональных данных"}`, "privacy_accepted", false, true)}<div class="form-error" role="alert"></div><button type="submit" class="button submit" ${!canRegister ? "disabled" : ""}>Получить код на почту</button></form><div class="auth-switch">Уже есть профиль? <button type="button" data-action="login-view">Войти</button></div>`,
  );
  const viewToken = state.view;
  const hash = location.hash;
  bindForm(document.querySelector("#auth-form"), async (data, form) => {
    if (!canRegister) throw Error(unavailable);
    const payload = {
      email: data.get("email").trim(),
      password: data.get("password"),
      full_name: data.get("full_name").trim(),
      gender: data.get("gender"),
      city: data.get("city").trim(),
      rules_accepted: data.has("rules_accepted"),
      privacy_accepted: data.has("privacy_accepted"),
    };
    if (payload.password !== data.get("repeat_password"))
      throw Error("Пароли не совпадают. Повторите пароль ещё раз.");
    if (data.get("birth_date")) payload.birth_date = data.get("birth_date");
    const result = await write("/auth/register", payload);
    if (!form.isConnected || state.view !== viewToken || location.hash !== hash)
      return;
    if (result.verification_required) {
      state.verification = {
        email: result.email || payload.email,
        resendAt: Date.now() + number(result.resend_after || 30) * 1000,
        expiresAt: Date.now() + number(result.expires_in || 600) * 1000,
      };
      navigate("verify");
      return;
    }
    if (!result.user)
      throw Error(
        "Не удалось завершить регистрацию. Обновите страницу и повторите действие.",
      );
    await finishLogin(result, state.afterLogin || "dashboard");
  });
}
async function finishLogin(result, route) {
  clearModuleState();
  clearInterval(state.loginVerificationTimer);
  state.loginVerification = null;
  clearInterval(state.verificationTimer);
  state.verification = null;
  state.user = result.user;
  if (result.csrfToken) state.csrf = result.csrfToken;
  else await refreshCSRF();
  state.afterLogin = null;
  history.replaceState(
    null,
    "",
    `#${staff() && route === "dashboard" ? "users" : route}`,
  );
  PortalUI.syncHash();
  renderShell();
}
function otpField(demo = false) {
  return `<fieldset class="otp-fieldset"><legend>${demo ? "Код тестового аккаунта" : "Код из письма"}</legend><input type="hidden" name="verification_code" id="verification_code"><div class="otp-cells">${[0, 1, 2, 3].map((index) => `<input class="otp-cell" type="text" inputmode="numeric" autocomplete="${index === 0 ? "one-time-code" : "off"}" maxlength="4" pattern="[0-9]" required aria-label="Цифра ${index + 1} из 4" data-otp="${index}" placeholder="—">`).join("")}</div></fieldset>`;
}
function bindOTP(selector = "#verification-form") {
  const form = document.querySelector(selector);
  const cells = [...form.querySelectorAll("[data-otp]")];
  const sync = () => {
    form.elements.verification_code.value = cells
      .map((cell) => cell.value)
      .join("");
  };
  const distribute = (index, text) => {
    const numeric = text.replace(/[^0-9]/g, "");
    if (numeric.length === 4) index = 0;
    const digits = numeric.slice(0, 4 - index);
    if (!digits) {
      cells[index].value = "";
      sync();
      return;
    }
    [...digits].forEach((digit, offset) => {
      cells[index + offset].value = digit;
    });
    cells[Math.min(3, index + digits.length)].focus();
    sync();
  };
  cells.forEach((cell, index) => {
    cell.addEventListener("focus", () => cell.select());
    cell.addEventListener("input", () => distribute(index, cell.value));
    cell.addEventListener("paste", (event) => {
      event.preventDefault();
      distribute(index, event.clipboardData.getData("text"));
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !cell.value && index > 0) {
        cells[index - 1].value = "";
        cells[index - 1].focus();
        sync();
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        cells[index - 1].focus();
      }
      if (event.key === "ArrowRight" && index < 3) {
        event.preventDefault();
        cells[index + 1].focus();
      }
    });
  });
}
function renderVerification(info = "") {
  state.view++;
  clearInterval(state.loginVerificationTimer);
  clearInterval(state.verificationTimer);
  const pending = state.verification || {
    email: "",
    resendAt: 0,
    expiresAt: 0,
  };
  state.verification = pending;
  const mailAvailable = state.config.email_verification_available === true;
  app.innerHTML = authLayout(
    `<div class="section-kicker">ПОДТВЕРЖДЕНИЕ ПОЧТЫ</div><h1>Проверьте почту</h1><p class="muted">${pending.email ? `Введите 4-значный код из письма, отправленного на <strong>${h(pending.email)}</strong>.` : "Введите почту, указанную при регистрации, и 4-значный код из письма."} Код действует 10 минут.</p>${info ? `<div class="notice success" role="status">${h(info)}</div>` : ""}${!mailAvailable ? '<div class="notice">Повторная отправка писем сейчас недоступна. Если вы уже получили код, попробуйте подтвердить его.</div>' : ""}<form id="verification-form">${field("Электронная почта", "verification_email", pending.email, "email", true, 'autocomplete="email" maxlength="254"')}${otpField()}<p id="verification-help" class="muted small">Если письма нет, проверьте папку «Спам». Используйте последнее полученное письмо и тот же браузер, в котором начали регистрацию.</p><div id="verification-expiry" class="muted small" role="status"></div><div class="form-error" role="alert"></div><button type="submit" class="button submit">Подтвердить и заполнить анкету</button></form><div class="verification-resend"><button type="button" class="button secondary" data-action="resend-verification" ${!mailAvailable ? "disabled" : ""}>Отправить код повторно</button><span id="verification-countdown" class="muted small" aria-live="polite"></span></div><div class="auth-switch"><button type="button" data-action="register-view">Изменить данные регистрации</button><button type="button" data-action="login-view">Вернуться ко входу</button></div>`,
  );
  const updateTimer = () => {
    const resend = document.querySelector(
      '[data-action="resend-verification"]',
    );
    const countdown = document.querySelector("#verification-countdown");
    const expiry = document.querySelector("#verification-expiry");
    if (!resend || !countdown || !expiry) {
      clearInterval(state.verificationTimer);
      return;
    }
    const seconds = Math.max(
      0,
      Math.ceil((pending.resendAt - Date.now()) / 1000),
    );
    resend.disabled =
      !mailAvailable || seconds > 0 || Boolean(state.verificationSending);
    countdown.textContent = seconds
      ? `Отправить снова через ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
      : "";
    expiry.textContent =
      pending.expiresAt && pending.expiresAt <= Date.now()
        ? "Срок действия кода истёк. Запросите новый код."
        : "";
  };
  bindOTP();
  updateTimer();
  state.verificationTimer = setInterval(updateTimer, 1000);
  const viewToken = state.view;
  const hash = location.hash;
  bindForm(document.querySelector("#verification-form"), async (data, form) => {
    const code = data.get("verification_code").trim();
    if (!/^[0-9]{4}$/.test(code))
      throw Error("Введите 4 цифры кода из письма.");
    const result = await write("/auth/verify-email", {
      email: data.get("verification_email").trim(),
      code,
    });
    // A completed request must not reopen a screen the user has already left.
    if (!form.isConnected || state.view !== viewToken || location.hash !== hash)
      return;
    if (!result.user)
      throw Error("Не удалось подтвердить почту. Попробуйте ещё раз.");
    await finishLogin(result, "questionnaire");
    toast("Почта подтверждена. Давайте познакомимся поближе.");
  });
}
async function resendVerification() {
  if (state.verificationSending) return;
  const input = document.querySelector("#verification_email");
  if (!input?.reportValidity()) return;
  const form = input.closest("form");
  const viewToken = state.view;
  const hash = location.hash;
  const email = input.value.trim();
  state.verificationSending = true;
  try {
    const result = await write("/auth/resend-code", { email });
    if (!form.isConnected || state.view !== viewToken || location.hash !== hash)
      return;
    state.verification = {
      email: result.email || email,
      resendAt: Date.now() + number(result.resend_after || 30) * 1000,
      expiresAt: Date.now() + number(result.expires_in || 600) * 1000,
    };
    renderVerification("Новый код отправлен. Проверьте входящие письма.");
  } catch (error) {
    if (!form.isConnected || state.view !== viewToken || location.hash !== hash)
      return;
    if (error.retryAfter)
      state.verification.resendAt =
        Date.now() + number(error.retryAfter) * 1000;
    const errorBox = document.querySelector("#verification-form .form-error");
    if (errorBox) errorBox.textContent = error.message;
    else throw error;
  } finally {
    state.verificationSending = false;
  }
}

function scrollHomeSection(section) {
  if (!["about", "directions", "start"].includes(section)) return;
  if (section === "start")
    document.querySelector(".home-page")?.classList.add("show-start");
  PortalUI.closePublicMenu();
  PortalUI.scrollToElement(document.querySelector(`#home-${section}`));
}

function renderHome() {
  state.view++;
  clearInterval(state.verificationTimer);
  clearInterval(state.loginVerificationTimer);
  const join = state.user ? "#questionnaire" : "#register";
  const directions = [
    [
      "event-1.jpg",
      "МАСТЕРСКАЯ · МОСКВА",
      "Арт-суббота: помочь на занятии",
      "Творческие встречи и поддержка участников.",
    ],
    [
      "event-2.jpg",
      "ТВОРЧЕСТВО · МОСКВА",
      "Творить вместе в арт-лаборатории",
      "Занятия и совместное творчество.",
    ],
    [
      "event-3.jpg",
      "ИНКЛЮЗИВНЫЕ МАСТЕРСКИЕ",
      "Руки, которые помогают создавать",
      "Керамика, ткани, рисование.",
    ],
  ];
  app.innerHTML = `<div class="public-page home-page ${state.homeSection === "start" ? "show-start" : ""}">${publicHeader()}<main id="content" class="home-content"><section class="home-hero"><div class="home-mobile-intro"><p class="section-kicker">ВОЛОНТЁРЫ ДЕТЕЙ МАРИИ</p><h1>Здесь каждый<br>нужен.</h1><p>Быть рядом. Творить вместе.<br>Начните с того, что вам близко.</p></div><div class="hero-photo"><picture><source media="(max-width: 767px)" srcset="${figmaAsset("home-mobile-hero.png")}"><img class="hero-photo-image" src="${figmaAsset("home-hero.jpg")}" alt="Команда фонда «Дети Марии»"></picture><img class="hero-shade" src="${figmaAsset("light-20261022/19b94.svg")}" alt=""><img class="hero-fade" src="${figmaAsset("light-20261022/1f302.svg")}" alt=""><div class="hero-title"><h1>Здесь нужен<br>каждый.</h1><span class="chalk chalk-mint" aria-hidden="true"></span></div><a class="hero-cta" href="${join}"><span>Присоединиться</span><span class="hero-cta-arrow"><img src="${figmaAsset("e78ad.svg")}" alt=""></span></a></div></section><section class="home-about" id="home-about"><div class="home-about-heading"><p class="section-kicker">БОЛЬШЕ 30 ЛЕТ РЯДОМ</p><h2>Всё начинается<br>с человеческого<br>тепла.</h2><span class="chalk chalk-peach" aria-hidden="true"></span></div><div class="home-about-body"><h3>«Дети Марии» — место, где творчество помогает найти своё место в мире.</h3><p>Из небольшой волонтёрской инициативы выросло инклюзивное пространство для детей-сирот, выпускников детских домов, детей и взрослых с ментальными особенностями.</p><p>Мы рисуем, создаём керамику, готовим и учимся быть вместе. Волонтёры помогают на занятиях, сопровождают участников и становятся частью их жизни.</p><div class="home-values">${["Творчество", "Общение", "Поддержка"].map((name, i) => `<div><span>0${i + 1}</span><strong>${name}</strong></div>`).join("")}</div></div><div class="home-mobile-story"><p class="section-kicker">НАША ИСТОРИЯ · С 1993 ГОДА</p><h2>Творчество,<br>которое сближает</h2><p>Всё началось с творческих встреч в детском доме. Сегодня «Дети Марии» помогают детям и взрослым становиться самостоятельнее — через творчество, обучение и поддержку.</p></div></section><section class="home-directions" id="home-directions"><div class="section-heading"><h2>Найдите своё дело</h2><a href="#opportunities">Все возможности →</a></div><div class="event-grid">${directions.map(([photo, kicker, title, description]) => `<article class="portal-event-card"><img class="event-photo" src="${figmaAsset(photo)}" alt="" loading="lazy"><div class="event-card-body"><p class="section-kicker">${kicker}</p><h3>${title}</h3><p class="muted">${description}</p><a class="event-card-link" href="#opportunities">Посмотреть возможности ${icon("arrow")}</a></div></article>`).join("")}</div></section><section class="home-start" id="home-start"><h2>Как начать</h2><ol>${[
    ["Расскажите о себе", "Интересы, навыки и удобное время."],
    ["Познакомимся", "Координатор поможет выбрать формат."],
    ["Сделайте первый шаг", "Выберите возможность и присоединяйтесь."],
  ]
    .map(
      ([title, body], i) =>
        `<li><span>0${i + 1}</span><div><strong>${title}</strong><p>${body}</p></div></li>`,
    )
    .join(
      "",
    )}</ol><a class="button" href="${join}">Стать частью команды →</a></section></main>${publicFooter()}</div>`;
  PortalUI.bindHero();
  if (state.homeSection) {
    scrollHomeSection(state.homeSection);
    state.homeSection = null;
  }
}
function renderShell() {
  const route = (
    location.hash.slice(1) || (state.user ? "dashboard" : "home")
  ).split("/")[0];
  if (
    [
      "home",
      "login",
      "register",
      "verify",
      "login-code",
      "forgot-password",
      "reset-password",
    ].includes(route) ||
    !state.user
  )
    return renderRoute();
  const ownQuestionnaire =
    ["questionnaire", "questionnaire-sent"].includes(route) &&
    !location.hash.slice(1).split("/")[1];
  if (ownQuestionnaire) {
    app.innerHTML = `<div class="public-page questionnaire-shell">${publicHeader()}<main id="content" class="questionnaire-content" tabindex="-1"></main></div>`;
    return renderRoute();
  }
  const mainNav = staff()
    ? [
        ["users", "Волонтёры"],
        ["organizer-events", "Мероприятия"],
        ["training", "Курсы"],
        ["staff-tasks", "Задачи"],
        ["groups", "Сообщения"],
        ["kistik", "Кистик"],
      ]
    : [
        ["dashboard", "Мой кабинет"],
        ["opportunities", "Возможности"],
        ["training", "Обучение"],
        ["participation", "Мой вклад"],
        ["groups", "Сообщения"],
        ["kistik", "Кистик"],
      ];
  const workNav = [],
    extraNav = staff()
      ? [
          ...(admin() ? [["access", "Доступ и журнал"]] : []),
          ...(manager() ? [["analytics", "Аналитика"]] : []),
        ]
      : [];
  const nav = (items) =>
    items
      .map(
        ([key, title]) =>
          `<${key === "chat" ? 'button type="button" data-action="open-chat"' : "a"} class="nav-item ${route === key ? "active" : ""}" ${key === "chat" ? "" : `href="#${key}"`} aria-label="${h(title)}" title="${h(title)}" ${route === key ? 'aria-current="page"' : ""}>${icon(key === "chat" || key === "groups" ? "messages" : key === "organizer-events" ? "opportunities" : key === "campaigns" ? "notifications" : key)}<span class="nav-label">${title}</span>${key === "groups" ? '<span id="group-unread-badge" class="pill" hidden></span>' : ""}</${key === "chat" ? "button" : "a"}>`,
      )
      .join("");
  app.innerHTML = `<div class="layout ${staff() ? "organizer-layout" : ""}"><button class="shell-backdrop" type="button" data-action="shell-menu" aria-label="Закрыть меню" hidden></button><aside class="sidebar" id="sidebar"><button class="close-button shell-close-button" type="button" data-action="shell-menu" aria-label="Закрыть меню">×</button><div class="sidebar-main">${brand()}<nav aria-label="Разделы кабинета">${nav(mainNav)}${workNav.length ? `<div class="nav-group-label">Моё участие</div>${nav(workNav)}` : ""}${extraNav.length ? `<div class="nav-group-label">УПРАВЛЕНИЕ</div>${nav(extraNav)}` : ""}</nav></div><div class="sidebar-bottom"><a class="sidebar-account" href="#profile" aria-label="Мой профиль" title="Мой профиль"><span class="avatar" aria-hidden="true">${h(initials(state.user.full_name))}</span><span class="sidebar-account-copy"><span class="account-name">${h(state.user.full_name)}</span><span class="account-role">Мой профиль</span></span></a><button class="button ghost compact" type="button" data-action="logout">Выйти</button></div></aside><div class="main-column"><header class="topbar"><button class="button secondary shell-menu-button" type="button" aria-label="Открыть меню кабинета" aria-controls="sidebar" aria-expanded="false" data-action="shell-menu">${icon("menu")}</button><span class="topbar-label">${demoEmailAccount() ? "ТЕСТОВЫЙ АККАУНТ" : staff() ? "ПРОСТРАНСТВО ОРГАНИЗАТОРА" : "ПРОСТРАНСТВО ВОЛОНТЁРА"}</span><div class="organizer-top-actions"><a class="notification-link ${route === "notifications" ? "active" : ""}" href="#notifications" aria-label="Уведомления">${icon(route === "notifications" ? "notificationsActive" : "notifications")}<span id="unread-badge" class="badge-count" hidden></span></a></div></header>${demoAccessNotice()}<main id="content" class="content ${staff() ? "organizer-content" : ""}" tabindex="-1"></main></div></div>`;
  PortalUI.bindShell();
  renderRoute();
}

async function refreshBadge() {
  const user = state.user;
  if (!user) return;
  const badges = ["unread-badge", "group-unread-badge"].map((id) =>
    document.getElementById(id),
  );
  const results = await Promise.allSettled([
    api("/notifications/unread-count"),
    api("/groups/unread-count"),
  ]);
  if (state.user !== user) return;
  // Keep the original nodes: a late count must not touch a replaced shell or closed page.
  badges.forEach((badge, index) => {
    const result = results[index];
    if (result.status !== "fulfilled" || !badge?.isConnected) return;
    const count = number(result.value.unread);
    badge.textContent = count > 99 ? "99+" : count;
    badge.hidden = !count;
  });
}

async function renderRoute() {
  const requested =
    location.hash.slice(1) || (state.user ? "dashboard" : "home");
  if (requested.split("/")[0] === "role-preview") {
    history.replaceState(
      null,
      "",
      state.user ? (staff() ? "#users" : "#dashboard") : "#home",
    );
    PortalUI.syncHash();
    return renderShell();
  }
  if (requested === "kistik" && state.currentViewRoute !== "kistik")
    state.kistikOrigin = state.currentViewRoute || "kistik";
  state.currentViewRoute = requested.split("?")[0];
  if (requested !== "kistik") window.PortalKistik?.destroy();
  if (requested === "home") return renderHome();
  if (requested === "forgot-password") return PortalAccounts.renderRecovery();
  if (requested.startsWith("reset-password/"))
    return PortalAccounts.renderRecovery(
      requested.slice("reset-password/".length),
    );
  if (requested === "login") return renderAuth(false);
  if (requested === "register") return renderAuth(true);
  if (requested === "verify") return renderVerification();
  if (requested === "login-code") return renderLoginCode();
  if (requested === "kistik" && !state.user) return renderKistik();
  if (!state.user && !requested.startsWith("opportunities")) {
    state.afterLogin = requested;
    return renderAuth(false);
  }
  if (!state.user && requested.startsWith("opportunities"))
    app.innerHTML = `<div class="public-page">${publicHeader()}<main id="content" class="content public-catalog" tabindex="-1"></main>${publicFooter()}</div>`;
  const token = ++state.view;
  const [routePath, routeSearch = ""] = requested.split("?");
  const [route = "dashboard", id] = routePath.split("/");
  const routeQuery = new URLSearchParams(routeSearch);
  state.route = route;
  const content = document.querySelector("#content");
  if (!content) return renderShell();
  document.querySelectorAll(".nav-item").forEach((link) => {
    const activeRoute = staff()
      ? {
          dashboard: "users",
          opportunities: "organizer-events",
          "event-editor": "organizer-events",
          "event-announcement": "organizer-events",
          campaigns: "groups",
          messages: "groups",
          "event-chat": "groups",
          "questionnaire-import": "users",
          questionnaire: id ? "users" : "profile",
        }[route] || route
      : route === "event-chat"
        ? "groups"
        : route === "applications"
          ? "participation"
          : route;
    const current = link.getAttribute("href") === `#${activeRoute}`;
    link.classList.toggle("active", current);
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  content.innerHTML =
    '<div class="loading" role="status">Загружаем данные…</div>';
  const set = (html) => {
    if (state.view === token) {
      content.innerHTML = html;
      // Keep wide data tables reachable by keyboard inside their own scroll area.
      content.querySelectorAll(".table-wrap").forEach((table, index) => {
        table.tabIndex = 0;
        table.setAttribute("role", "region");
        const title =
          table.closest("section")?.querySelector("h2")?.textContent ||
          content.querySelector("h1")?.textContent ||
          `Таблица ${index + 1}`;
        table.setAttribute("aria-label", title);
      });
    }
    return state.view === token;
  };
  set.current = () => state.view === token;
  try {
    if (window.PortalOrganizer?.handles(route))
      await PortalOrganizer.render(route, id, set);
    else if (route === "dashboard" && staff())
      await PortalOrganizer.render("users", null, set);
    else if (route === "dashboard") await renderDashboard(set);
    else if (route === "kistik") await renderKistik(set);
    else if (route === "opportunities" && staff())
      await PortalOrganizer.render("organizer-events", id, set);
    else if (route === "opportunities") await renderOpportunities(set, id);
    else if (route === "applications") await renderApplications(set);
    else if (route === "training")
      await PortalCourses.render({
        set,
        user: state.user,
        api,
        write,
        toast,
        route: requested,
      });
    else if (route === "questionnaire-import" && manager())
      await PortalImports.render({ set, api, user: state.user });
    else if (["groups", "event-chat"].includes(route))
      await PortalCommunity.render({
        set,
        api,
        user: state.user,
        groupId: route === "groups" ? id : null,
        eventId: route === "event-chat" ? id : null,
      });
    else if (route === "messages" && manager())
      await DMMessaging.renderInbox(set, {
        api,
        user: state.user,
        threadId: id,
      });
    else if (route === "campaigns" && manager()) {
      if (id)
        await DMMessaging.renderCampaignEditor(set, {
          api,
          user: state.user,
          campaignId: id === "new" ? null : id,
          eventId: routeQuery.get("event_id"),
        });
      else await DMMessaging.renderCampaigns(set, { api, user: state.user });
    } else if (route === "participation") await renderParticipation(set);
    else if (route === "profile") await renderProfile(set);
    else if (route === "questionnaire") await renderQuestionnaire(set, id);
    else if (route === "questionnaire-edit")
      await renderQuestionnaire(set, null, true);
    else if (route === "questionnaire-sent") await renderSuccess(set);
    else if (route === "users" && staff()) await renderUsers(set, id);
    else if (route === "analytics" && manager()) await renderAnalytics(set);
    else if (route === "notifications") await renderNotifications(set);
    else if (route === "thanks") await renderThanks(set);
    else if (route === "audit" && admin()) await renderAudit(set);
    else
      set(
        empty(
          "Раздел недоступен",
          "Выберите доступный раздел в меню кабинета.",
        ),
      );
  } catch (error) {
    if (state.view !== token) return;
    if (error.status === 401) return expiredSession();
    set(`${errorHTML(error)}${button("Повторить загрузку", "reload")}`);
  }
  if (state.user) refreshBadge();
}

const queryString = (values) =>
  new URLSearchParams(
    Object.entries(values).filter(
      ([, value]) => value !== "" && value !== null && value !== undefined,
    ),
  ).toString();
const listView = (key) => (state.listViews[key] ||= { page: 1 });
const pageItems = (value) =>
  Array.isArray(value) ? value : list(value?.items);
async function loadList(path, key, filters = {}) {
  const view = listView(key);
  const load = () =>
    api(
      `${path}?${queryString({ ...filters, page: view.page, page_size: 50 })}`,
    );
  let data = await load();
  const last = Math.max(1, number(data.pages));
  if (view.page > last) {
    view.page = last;
    data = await load();
  }
  return data;
}
function pagination(data, key) {
  const page = number(data?.page) || 1,
    pages = Math.max(1, number(data?.pages));
  return `<div class="pagination"><span>Найдено: ${number(data?.total)} · Страница ${page} из ${pages}</span><div class="actions">${button("← Назад", "list-page", `data-list="${h(key)}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}`, true)}${button("Далее →", "list-page", `data-list="${h(key)}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}`, true)}</div></div>`;
}
function bindListFilter(selector, key, names) {
  bindForm(document.querySelector(selector), async (data) => {
    const dateFrom = String(data.get("date_from") || ""),
      dateTo = String(data.get("date_to") || "");
    if (dateFrom && dateTo && dateFrom > dateTo)
      throw Error("Начало периода должно быть не позже окончания.");
    const view = listView(key);
    for (const name of names) view[name] = String(data.get(name) || "").trim();
    view.page = 1;
    await renderRoute();
  });
}
const applicationStatuses = [
  ["", "Все статусы"],
  ["pending", "На рассмотрении"],
  ["accepted", "Подтверждены"],
  ["rejected", "Отклонены"],
  ["withdrawn", "Отозваны"],
];
const periodFields = (view) =>
  `${field("С даты", "date_from", view.date_from || "", "date", false, 'min="1900-01-01" max="9999-12-31"')}${field("По дату", "date_to", view.date_to || "", "date", false, 'min="1900-01-01" max="9999-12-31"')}`;

const eventImage = (event, className = "event-photo") => {
  const url = event.cover_url;
  return /^\/(assets|uploads)\/[\w./-]+$/.test(url || "") && !url.includes("..")
    ? `<img class="${className}" src="${h(url)}" alt="${h(event.cover_alt || "")}" loading="lazy">`
    : `<div class="${className} event-cover-placeholder" role="img" aria-label="Обложка мероприятия пока не добавлена"><span>Дети Марии</span></div>`;
};
const eventDuration = (event) => {
  const duration =
    (new Date(event.ends_at).getTime() - new Date(event.starts_at).getTime()) /
    3600000;
  return event.starts_at && event.ends_at && duration > 0
    ? `${Number(duration.toFixed(2)).toLocaleString("ru-RU")} ч. участия`
    : "Время уточнит координатор";
};
function eventCard(event) {
  const badges = `${event.status !== "open" ? statusPill(event.status) : ""}${event.my_application ? statusPill(event.my_application) : ""}${number(event.match_score) > 0 && !staff() ? `<span class="pill match">Совпадений с анкетой: ${number(event.match_score)}</span>` : ""}`;
  const places = event.capacity
    ? event.accepted_count == null
      ? `Мест на встрече: ${number(event.capacity)}`
      : `Свободно ${Math.max(0, number(event.capacity) - number(event.accepted_count))} из ${number(event.capacity)} мест`
    : "Участие по согласованию";
  return `<article class="portal-event-card opportunity-card"><a class="event-image-link" href="#opportunities/${event.id}" tabindex="-1" aria-hidden="true">${eventImage(event)}</a><div class="event-card-body"><p class="section-kicker">${h([event.format, event.city].filter(Boolean).join(" · ") || "ВОЗМОЖНОСТЬ УЧАСТИЯ")}</p><h3><a href="#opportunities/${event.id}">${h(event.title)}</a></h3><div class="event-card-meta"><p>${event.starts_at ? date(event.starts_at, true) : "Дата уточняется"}</p><p>${h(eventDuration(event))}</p>${event.location ? `<p class="event-card-location">${h(event.location)}</p>` : ""}</div>${badges ? `<div class="tags">${badges}</div>` : ""}<div class="event-card-footer"><p class="event-card-capacity">${h(event.status === "open" ? places : event.status === "draft" ? "Готовится к публикации" : "Набор на встречу закрыт")}</p><a class="event-card-link" href="#opportunities/${event.id}">Подробнее ${icon("arrow")}</a>${staff() ? button("Изменить", "edit-event", `data-id="${event.id}"`, true) : ""}</div></div></article>`;
}

const opportunityFilterNames = [
  "q",
  "city",
  "format",
  "interest",
  "skill",
  "status",
  "date_from",
  "date_to",
  "available",
  "sort",
];

async function renderOpportunities(set, id) {
  if (id) {
    const key = `participants:${id}`,
      view = listView(key);
    const [result, participantsData] = await Promise.all([
      api(
        `/${state.user ? "" : "public/"}opportunities/${encodeURIComponent(id)}`,
      ),
      staff()
        ? loadList(
            `/opportunities/${encodeURIComponent(id)}/participants`,
            key,
            { q: view.q, status: view.status },
          )
        : Promise.resolve(null),
    ]);
    if (!set.current()) return;
    const event = result.item,
      participants = pageItems(participantsData);
    state.events.clear();
    state.events.set(String(event.id), event);
    const roster = staff()
      ? `<section class="roster-section"><div class="section-heading"><h2>Участники и отклики</h2><span class="muted">Подтверждено: ${number(event.accepted_count)}</span></div><form id="participants-filter" class="filters">${field("Имя или почта", "q", view.q || "", "search", false, 'maxlength="120"')}${select("Статус", "status", applicationStatuses, view.status || "")}<button type="submit" class="button secondary">Найти</button></form>${participants.length ? `<div class="table-wrap"><table><thead><tr><th>Волонтёр</th><th>Статус</th><th>Часы</th><th>Действия</th></tr></thead><tbody>${participants.map((person) => `<tr><td class="content-cell"><a href="#users/${person.user_id}">${h(person.full_name)}</a><div class="muted">${h(person.email)}</div></td><td>${statusPill(person.status)}</td><td>${h(person.hours ?? 0)}</td><td><div class="actions">${person.status === "pending" ? `${button("Подтвердить", "application-status", `data-id="${person.application_id}" data-status="accepted"`)}${button("Отклонить", "application-status", `data-id="${person.application_id}" data-status="rejected"`, true)}` : ""}${person.status === "accepted" ? button("Записать часы", "event-hours", `data-event="${event.id}" data-user="${person.user_id}"`) : ""}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Откликов не найдено", "Измените фильтры или дождитесь новых откликов.")}${pagination(participantsData, key)}</section>`
      : "";
    if (
      !set(
        `${header(event.title, "Творчество — хороший повод познакомиться. Приходите помогать и создавать вместе.", staff() ? button("Редактировать", "edit-event", `data-id="${event.id}"`, true) : "")}<a class="back-link" href="#opportunities">← Все возможности</a>${event.archived_at ? '<div class="card" role="status"><strong>Мероприятие удалено из каталога</strong><p>Эта карточка сохранена в истории вашего отклика. Новые заявки не принимаются.</p></div>' : ""}<div class="event-detail-layout"><article class="event-detail-main">${eventImage(event, "event-detail-photo")}<div class="tags">${statusPill(event.status)}${tags(event.skills)}${event.my_application ? statusPill(event.my_application) : ""}</div><section><h2>Что будем делать</h2><p class="preserve muted">${h(event.description)}</p></section><section class="event-preparation"><h2>Перед первой встречей</h2><p class="preserve muted">${h(event.preparation || "Познакомьтесь с вводными материалами. Координатор расскажет о вашей роли и особенностях группы.")}</p>${event.required_course_id ? `<a class="text-link" href="#training/course/${event.required_course_id}">${h(event.required_course_title || "Курс подготовки")} →</a><p class="muted small">Прохождение курса не подтверждает заявку автоматически.</p>` : '<a class="text-link" href="#training">Перейти к обучению →</a>'}</section></article><aside class="card event-booking"><p class="section-kicker">ВСТРЕЧА</p><h2>${event.starts_at ? date(event.starts_at) : "Уточняем дату"}</h2><p>${event.starts_at ? date(event.starts_at, true) : "Координатор сообщит время"}</p><div class="event-facts">${event.coordinator_name ? `<p><span>Координатор: ${h(event.coordinator_name)}</span></p>` : ""}${event.application_deadline ? `<p><span>Приём заявок до ${date(event.application_deadline, true)}</span></p>` : ""}<p>${icon("location")}<span>${h([event.city, event.location].filter(Boolean).join(" · ") || "Место уточняется")}</span></p><p>${icon("clock")}<span>${h(eventDuration(event))}</span></p><p>${icon("team")}<span>${event.capacity ? `Мест: ${number(event.capacity)}${state.user ? ` · подтверждено: ${number(event.accepted_count)}` : ""}` : "Команда и координатор"}</span></p>${event.ends_at ? `<p><span>Окончание: ${date(event.ends_at, true)}</span></p>` : ""}</div>${list(event.interests).length ? `<div class="tags">${tags(event.interests)}</div>` : ""}<div class="event-apply">${staff() ? `<a class="button secondary" href="#applications">Открыть отклики</a>` : applyButton(event)}<p class="muted small">${event.my_application ? "Статус участия доступен в разделе «Мой вклад»." : "После отклика координатор подтвердит участие и расскажет детали."}</p></div></aside></div>${event.my_application === "accepted" ? `<p><a class="button secondary" href="#event-chat/${h(event.id)}">Чат участников встречи</a></p>` : ""}${roster}`,
      )
    )
      return;
    if (staff()) bindListFilter("#participants-filter", key, ["q", "status"]);
    return;
  }
  const view = listView("opportunities");
  const path = state.user ? "/opportunities" : "/public/opportunities";
  const [data, options] = await Promise.all([
    loadList(
      path,
      "opportunities",
      Object.fromEntries(
        opportunityFilterNames.map((name) => [name, view[name]]),
      ),
    ),
    api(`${path}/options/filters`),
  ]);
  if (!set.current()) return;
  const items = pageItems(data);
  state.events.clear();
  items.forEach((event) => state.events.set(String(event.id), event));
  const statuses = [
    ["", "Все доступные"],
    ["open", "Открытые"],
    ["closed", "Закрытые"],
    ...(staff() ? [["draft", "Черновики"]] : []),
  ];
  const availableOptions = [
    ["", "Все возможности"],
    ["true", "Есть места и открыт набор"],
  ];
  const sortOptions = [
    ["soonest", "Сначала ближайшие"],
    ["latest", "Сначала поздние даты"],
    ["newest", "Сначала новые публикации"],
  ];
  const optionList = (values, placeholder, selected) => {
    const choices = list(values).filter((value) => typeof value === "string");
    if (selected && !choices.includes(selected)) choices.push(selected);
    return [["", placeholder], ...choices.map((value) => [value, value])];
  };
  const labels = {
    q: "Поиск",
    city: "Город",
    format: "Формат",
    interest: "Интерес",
    skill: "Навык",
    status: "Статус",
    date_from: "С даты",
    date_to: "По дату",
    available: "Места",
    sort: "Порядок",
  };
  const active = opportunityFilterNames.filter(
    (name) => view[name] && !(name === "sort" && view[name] === "soonest"),
  );
  const advancedCount = active.filter(
    (name) => !["q", "city", "format"].includes(name),
  ).length;
  const filterText = (name) => {
    if (name === "status")
      return (
        statuses.find(([value]) => value === view[name])?.[1] || view[name]
      );
    if (name === "available")
      return (
        availableOptions.find(([value]) => value === view[name])?.[1] ||
        view[name]
      );
    if (name === "sort")
      return (
        sortOptions.find(([value]) => value === view[name])?.[1] || view[name]
      );
    if (name === "date_from" || name === "date_to") return date(view[name]);
    return view[name];
  };
  const chips = active.length
    ? `<div class="opportunity-filter-active"><p class="small muted">Применено условий: ${active.length}</p><ul aria-label="Применённые условия">${active.map((name) => `<li><button type="button" class="opportunity-filter-chip" data-action="remove-event-filter" data-filter="${name}" aria-label="${h(`Убрать условие ${labels[name]}: ${filterText(name)}`)}"><span>${h(labels[name])}: ${h(filterText(name))}</span><span aria-hidden="true">×</span></button></li>`).join("")}</ul></div>`
    : "";
  const filters = `<form id="event-filter" class="filters portal-filters opportunity-filters" aria-label="Фильтры возможностей"><div class="opportunity-filter-main"><div class="filter-search">${field("Поиск", "q", view.q || "", "search", false, 'placeholder="Название, описание или город" maxlength="120"')}</div>${select("Город", "city", optionList(options.cities, "Все города", view.city), view.city || "")}${select("Формат", "format", optionList(options.formats, "Любой формат", view.format), view.format || "")}</div><details class="opportunity-filter-details" ${(view.advancedOpen ?? Boolean(advancedCount)) ? "open" : ""}><summary>Дополнительные условия${advancedCount ? `<span class="opportunity-filter-count">${advancedCount}</span>` : ""}</summary><div class="opportunity-filter-advanced">${select("Интерес", "interest", optionList(options.interests, "Любые интересы", view.interest), view.interest || "")}${select("Навык", "skill", optionList(options.skills, "Любые навыки", view.skill), view.skill || "")}${periodFields(view)}${select("Статус", "status", statuses, view.status || "")}${select("Доступность записи", "available", availableOptions, view.available || "")}${select("Сортировка", "sort", sortOptions, view.sort || "soonest")}</div></details><div class="form-error" role="alert"></div><div class="opportunity-filter-actions"><button type="submit" class="button" data-pending-label="Ищем…">Показать возможности</button><button type="button" class="button ghost" data-action="reset-events">Сбросить всё</button><span class="small muted">Выберите условия и нажмите «Показать возможности».</span></div>${chips}</form>`;
  if (
    !set(
      `${header("Найти своё дело", "Выберите то, что вам близко. Для многих задач достаточно желания быть рядом.", staff() ? button("+ Создать событие", "new-event") : "")}${filters}<div class="section-heading"><h2>Возможности рядом с вами</h2><span class="muted small" role="status">Найдено: ${number(data.total)}</span></div>${items.length ? `<div class="event-grid">${items.map(eventCard).join("")}</div>` : active.length ? `${empty("По этим условиям ничего не найдено", "Попробуйте другой город, расширьте период или уберите часть условий.")}<div class="opportunity-empty-actions">${button("Показать все возможности", "reset-events", "", true)}</div>` : empty("Событий пока нет", "Новые возможности появятся здесь. Загляните позже.")}${pagination(data, "opportunities")}<div class="card inline-cta"><h2>Не нашли подходящее?</h2><a class="button secondary" href="#questionnaire">Рассказать об интересах</a></div>`,
    )
  )
    return;
  bindListFilter("#event-filter", "opportunities", opportunityFilterNames);
  document
    .querySelector(".opportunity-filter-details")
    .addEventListener("toggle", (event) => {
      view.advancedOpen = event.currentTarget.open;
    });
}

function contributionTabs(active) {
  return staff()
    ? ""
    : `<nav class="dm-tabs" aria-label="Мой вклад"><a class="dm-chip ${active === "participation" ? "selected" : ""}" href="#participation" ${active === "participation" ? 'aria-current="page"' : ""}>Мой вклад</a><a class="dm-chip ${active === "applications" ? "selected" : ""}" href="#applications" ${active === "applications" ? 'aria-current="page"' : ""}>Мои отклики</a></nav>`;
}
function applyButton(event) {
  if (event.archived_at) return '<span class="pill">Мероприятие удалено</span>';
  if (event.my_application && event.my_application !== "withdrawn")
    return statusPill(event.my_application);
  if (
    event.application_deadline &&
    Date.parse(event.application_deadline) <= Date.now()
  )
    return '<span class="pill">Приём заявок завершён</span>';
  if (!state.user)
    return event.status === "open"
      ? button("Войти и записаться", "event-login", `data-id="${event.id}"`)
      : statusPill(event.status);
  if (event.my_application && event.my_application !== "withdrawn")
    return statusPill(event.my_application);
  if (
    event.status === "open" &&
    event.training_requirement &&
    !event.training_requirement.completed
  ) {
    const requirement = event.training_requirement;
    return requirement.available
      ? `<p>Перед откликом пройдите курс «${h(event.required_course_title || "Подготовка к встрече")}».</p><a class="button" href="#training/course/${h(requirement.course_id)}">Пройти обязательный курс</a>`
      : '<p class="notice">Обязательный курс сейчас недоступен. Свяжитесь с координатором.</p>';
  }
  return event.status === "open"
    ? button("Хочу участвовать", "apply", `data-id="${event.id}"`)
    : "";
}
const splitTags = (value) =>
  String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

async function renderApplications(set) {
  const view = listView("applications");
  const data = await loadList("/applications", "applications", {
    status: view.status,
    date_from: view.date_from,
    date_to: view.date_to,
  });
  const items = pageItems(data);
  if (
    !set(
      `${header(staff() ? "Отклики волонтёров" : "Мои отклики", staff() ? "Подтверждайте участие и помогайте волонтёрам найти своё дело." : "Следите за рассмотрением заявок и готовьтесь к событиям.")}${contributionTabs("applications")}<form id="applications-filter" class="filters">${select("Статус", "status", applicationStatuses, view.status || "")}${periodFields(view)}<button type="submit" class="button secondary">Применить</button></form>${items.length ? `<div class="table-wrap"><table><thead><tr>${staff() ? "<th>Волонтёр</th>" : ""}<th>Событие</th><th>Дата отклика</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${items.map((item) => `<tr>${staff() ? `<td class="content-cell"><a href="#users/${item.user_id}">${h(item.full_name)}</a><div class="muted">${h(item.email)}</div></td>` : ""}<td class="description-cell"><a href="#opportunities/${item.opportunity_id}">${h(item.opportunity_title || item.title)}</a>${item.opportunity_archived_at ? '<span class="pill">Удалено из каталога</span>' : ""}${item.note ? `<div class="muted preserve">${h(item.note)}</div>` : ""}</td><td>${date(item.created_at)}</td><td>${statusPill(item.status)}</td><td><div class="actions">${staff() && !item.opportunity_archived_at && item.status === "pending" ? `${button("Принять", "application-status", `data-id="${item.id}" data-status="accepted"`)}${button("Отклонить", "application-status", `data-id="${item.id}" data-status="rejected"`, true)}` : ""}${staff() && item.status === "accepted" ? button("Записать часы", "event-hours", `data-event="${item.opportunity_id}" data-user="${item.user_id}"`, true) : ""}${!staff() && ["pending", "accepted"].includes(item.status) ? button("Отозвать", "application-status", `data-id="${item.id}" data-status="withdrawn"`, true) : ""}${!["pending", "accepted"].includes(item.status) ? '<span class="muted">—</span>' : ""}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Откликов не найдено", "Измените фильтры или выберите событие в разделе «Возможности».")}${pagination(data, "applications")}`,
    )
  )
    return;
  bindListFilter("#applications-filter", "applications", [
    "status",
    "date_from",
    "date_to",
  ]);
}
async function trainingDialog(id) {
  const view = state.view;
  const item = id
    ? (await api(`/training/${encodeURIComponent(id)}`)).item
    : {};
  if (view !== state.view || !state.user) return;
  openDialog(
    id ? "Редактировать материал" : "Новый учебный материал",
    `${field("Название", "title", item.title || "", "text", true, 'minlength="2" maxlength="200"')}${textarea("Описание", "description", item.description)}${field("Ссылка на материал", "url", item.url || "", "url", false, 'placeholder="https://…" maxlength="2000"')}${check("Обязательный материал", "required", item.required)}${check("Опубликовать для волонтёров", "published", item.published !== false)}`,
    async (data) => {
      await write(
        id ? `/training/${id}` : "/training",
        {
          title: data.get("title").trim(),
          description: data.get("description").trim(),
          url: data.get("url").trim(),
          required: data.has("required"),
          published: data.has("published"),
        },
        id ? "PATCH" : "POST",
      );
      dialog.close();
      toast("Учебный материал сохранён");
      await renderRoute();
    },
  );
}

async function renderParticipation(set) {
  const view = listView("participation");
  const [data, thanks] = await Promise.all([
    loadList("/participation", "participation", {
      date_from: view.date_from,
      date_to: view.date_to,
    }),
    staff() ? Promise.resolve(null) : api("/thanks?page=1&page_size=1"),
  ]);
  if (!set.current()) return;
  const items = pageItems(data),
    gratitude = pageItems(thanks)[0];
  state.participation.clear();
  items.forEach((item) => state.participation.set(String(item.id), item));
  const hours = number(data.summary?.total_hours),
    joined = new Date(state.user.created_at),
    now = new Date();
  const months = Math.max(
    0,
    (now.getFullYear() - joined.getFullYear()) * 12 +
      now.getMonth() -
      joined.getMonth(),
  );
  if (
    !set(
      `${header(staff() ? "Учёт участия" : "Мой вклад", staff() ? "Подтверждённые часы и история добрых дел команды." : "Встречи, которые уже состоялись, и маленькие шаги, из которых складывается поддержка.", staff() ? button("+ Записать участие", "new-hours") : "")}${contributionTabs("participation")}<div class="stats contribution-stats"><div class="stat"><strong>${hours.toLocaleString("ru-RU")} ч</strong><span>${staff() ? "Участие команды" : "Ваше участие в мероприятиях"}</span><small>Подтверждено координатором</small></div><div class="stat"><strong>${number(data.total)}</strong><span>Тёплые встречи</span><small>В выбранном периоде</small></div><div class="stat"><strong>${Number.isFinite(months) ? months : 0}</strong><span>Месяцев вместе</span><small>Спасибо, что вы с нами</small></div></div>${!staff() ? PortalAchievements.slot() : ""}<section class="card contribution-history"><div class="section-heading"><h2>История участия</h2></div><form id="participation-filter" class="filters">${periodFields(view)}<button type="submit" class="button secondary">Применить</button></form>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Возможность</th>${staff() ? "<th>Волонтёр</th>" : ""}<th>Дата</th><th>Часы</th><th>Статус</th>${staff() ? "<th>Действия</th>" : ""}</tr></thead><tbody>${items.map((item) => `<tr><td class="description-cell"><strong>${h(item.title || item.opportunity_title)}</strong>${item.note ? `<div class="muted preserve">${h(item.note)}</div>` : ""}</td>${staff() ? `<td class="content-cell"><a href="#users/${item.user_id}">${h(item.full_name)}</a></td>` : ""}<td>${date(item.participated_on)}</td><td><strong>${number(item.hours).toLocaleString("ru-RU")} ч</strong></td><td><span class="confirmed-status">${icon("confirmed")} Подтверждено</span></td>${staff() ? `<td>${button("Исправить", "edit-hours", `data-id="${item.id}"`, true)}</td>` : ""}</tr>`).join("")}</tbody></table></div><div class="contribution-total"><strong>Итого за выбранный период</strong><span>${hours.toLocaleString("ru-RU")} ч · Участий: ${number(data.total)}</span></div>` : empty("История начинается с первой встречи", "После участия координатор добавит сюда ваши часы.")}${pagination(data, "participation")}</section><div class="contribution-bottom">${gratitude ? `<article class="card gratitude-card"><p class="section-kicker">СЛОВА БЛАГОДАРНОСТИ</p><h2 class="preserve">${h(gratitude.message || gratitude.body)}</h2><p>${h(gratitude.author_name || gratitude.sender_name || "Команда «Детей Марии»")}</p><a href="#thanks">Все благодарности →</a></article>` : ""}<article class="card"><p class="section-kicker">ВМЕСТЕ С КОМАНДОЙ</p><h2>Каждая встреча — часть вашей истории</h2><p class="muted">Новые знакомства, общие дела и тёплые встречи команды.</p><a class="text-link" href="#opportunities">Выбрать следующую возможность →</a></article></div>`,
    )
  )
    return;
  if (!staff())
    PortalAchievements.mount({
      element: document.querySelector("[data-achievements]"),
      api,
      mode: "collection",
    });
  bindListFilter("#participation-filter", "participation", [
    "date_from",
    "date_to",
  ]);
}

function lookupMarkup(name, title, emptyLabel, required = false) {
  return `<fieldset class="lookup-picker" data-lookup="${name}"><legend>${h(title)}</legend><div class="lookup-search">${field("Поиск по имени или названию", `${name}_search`, "", "search", false, 'maxlength="120" autocomplete="off"')}<button type="button" class="button secondary compact" data-lookup-search>Найти</button></div>${select(title, name, [["", emptyLabel]], "", required)}<p class="lookup-selection muted small" data-lookup-selection></p><div class="lookup-error notice error" data-lookup-error role="alert" hidden></div><div class="lookup-footer"><span class="muted small" data-lookup-status role="status"></span><div class="actions"><button type="button" class="button secondary compact" data-lookup-prev aria-label="Предыдущая страница вариантов">←</button><button type="button" class="button secondary compact" data-lookup-next aria-label="Следующая страница вариантов">→</button></div></div></fieldset>`;
}
function createLookup(
  root,
  { load, label, emptyLabel, selectedItem = null, onChange },
) {
  const selectElement = root.querySelector("select");
  const search = root.querySelector('input[type="search"]');
  const status = root.querySelector("[data-lookup-status]");
  const errorBox = root.querySelector("[data-lookup-error]");
  const prev = root.querySelector("[data-lookup-prev]"),
    next = root.querySelector("[data-lookup-next]");
  let selected = selectedItem,
    page = 1,
    pages = 1,
    sequence = 0,
    timer;
  let items = [],
    busy = false,
    failed = false;
  const selectionText = () => {
    root.querySelector("[data-lookup-selection]").textContent = selected
      ? `Выбрано: ${label(selected)}`
      : emptyLabel;
  };
  function draw() {
    const choices = [...items];
    if (selected && !choices.some((item) => idsEqual(item.id, selected.id)))
      choices.unshift(selected);
    selectElement.innerHTML = `<option value="">${h(emptyLabel)}</option>${choices.map((item) => `<option value="${h(item.id)}" ${selected && idsEqual(item.id, selected.id) ? "selected" : ""}>${h(label(item))}</option>`).join("")}`;
    selectionText();
  }
  async function reload({
    reset = false,
    clear = false,
    clearSearch = false,
  } = {}) {
    clearTimeout(timer);
    if (reset) page = 1;
    if (clear) selected = null;
    if (clearSearch) search.value = "";
    const token = ++sequence;
    busy = true;
    failed = false;
    selectElement.disabled = true;
    prev.disabled = true;
    next.disabled = true;
    root.querySelector("[data-lookup-search]").disabled = true;
    errorBox.hidden = true;
    status.textContent = "Загружаем варианты…";
    try {
      let data = await load({ q: search.value.trim(), page, page_size: 50 });
      if (token !== sequence || !root.isConnected) return;
      pages = Math.max(1, number(data.pages));
      if (page > pages) {
        page = pages;
        data = await load({ q: search.value.trim(), page, page_size: 50 });
      }
      if (token !== sequence || !root.isConnected) return;
      items = pageItems(data);
      draw();
      status.textContent = `Найдено: ${number(data.total)} · Страница ${page} из ${pages}`;
    } catch (error) {
      if (token !== sequence || !root.isConnected) return;
      if (error.status === 401) {
        expiredSession();
        return;
      }
      failed = true;
      items = [];
      draw();
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      status.textContent =
        "Не удалось загрузить варианты. Нажмите «Найти», чтобы повторить.";
    } finally {
      if (token === sequence) {
        busy = false;
        selectElement.disabled = false;
        root.querySelector("[data-lookup-search]").disabled = false;
        prev.disabled = failed || page <= 1;
        next.disabled = failed || page >= pages;
      }
    }
  }
  selectElement.addEventListener("change", () => {
    selected =
      [...items, ...(selected ? [selected] : [])].find((item) =>
        idsEqual(item.id, selectElement.value),
      ) || null;
    selectionText();
    if (onChange) onChange(selected);
  });
  root.querySelector("[data-lookup-search]").onclick = () =>
    reload({ reset: true });
  prev.onclick = () => {
    page = Math.max(1, page - 1);
    void reload();
  };
  next.onclick = () => {
    page = Math.min(pages, page + 1);
    void reload();
  };
  search.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (root.isConnected) void reload({ reset: true });
    }, 300);
  };
  search.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void reload({ reset: true });
    }
  };
  draw();
  return {
    reload,
    get busy() {
      return busy;
    },
    get failed() {
      return failed;
    },
    get selected() {
      return selected;
    },
  };
}

async function hoursDialog({ id, eventId, userId } = {}) {
  const viewToken = state.view;
  const current = () => state.view === viewToken && staff();
  if (!id && eventId && userId) {
    const data = await api(
      `/participation?${queryString({ user_id: userId, opportunity_id: eventId, page: 1, page_size: 1 })}`,
    );
    if (!current()) return;
    const existing = pageItems(data)[0];
    if (existing) {
      state.participation.set(String(existing.id), existing);
      return hoursDialog({ id: existing.id });
    }
  }
  const record = id ? state.participation.get(String(id)) : null;
  if (id && !record)
    throw Error("Сначала откройте страницу с этой записью участия.");
  if (record) {
    openDialog(
      "Исправить запись участия",
      `<p class="muted">${h(record.full_name)} · ${h(record.opportunity_title || record.title)}</p>${field("Дата участия", "participated_on", dateOnly(record.participated_on), "date", true)}${field("Часы", "hours", record.hours, "number", true, 'step="0.25" min="0.25" max="24"')}${textarea("Комментарий для волонтёра", "note", record.note, false, 2000)}`,
      async (data) => {
        await write(
          `/participation/${id}`,
          {
            participated_on: data.get("participated_on"),
            hours: Number(data.get("hours")),
            note: data.get("note").trim(),
          },
          "PATCH",
        );
        dialog.close();
        toast("Запись участия исправлена");
        await renderRoute();
      },
    );
    return;
  }
  const [eventResponse, userResponse] = await Promise.all([
    eventId
      ? api(`/opportunities/${encodeURIComponent(eventId)}`)
      : Promise.resolve(null),
    userId
      ? api(`/users/${encodeURIComponent(userId)}?page_size=1`)
      : Promise.resolve(null),
  ]);
  if (!current()) return;
  const chosen = eventResponse?.item || null,
    person = userResponse?.user || null;
  if (person && person.role !== "volunteer")
    throw Error("Записывать участие можно только волонтёру.");
  if (chosen && person) {
    const accepted = await api(
      `/applications?${queryString({ opportunity_id: chosen.id, user_id: person.id, status: "accepted", page: 1, page_size: 1 })}`,
    );
    if (!current()) return;
    if (!pageItems(accepted).length)
      throw Error(
        "У волонтёра нет подтверждённого отклика на это событие. Обновите список участников.",
      );
  }
  let eventLookup, personLookup;
  openDialog(
    "Записать участие",
    `<p class="muted small">Для события выберите волонтёра с подтверждённым откликом. Поиск и страницы позволяют найти любую доступную запись.</p>${lookupMarkup("opportunity_id", "Событие", "Другая волонтёрская задача")}${lookupMarkup("user_id", "Волонтёр", "Выберите волонтёра", true)}${field("Название задачи", "title", chosen?.title || "", "text", true, 'minlength="2" maxlength="200"')}${field("Дата участия", "participated_on", chosen?.starts_at ? dateOnly(chosen.starts_at) : today(), "date", true)}${field("Часы", "hours", "", "number", true, 'step="0.25" min="0.25" max="24" placeholder="Например, 3"')}${textarea("Комментарий для волонтёра", "note", "", false, 2000)}`,
    async (data) => {
      if (eventLookup.busy || personLookup.busy)
        throw Error("Дождитесь загрузки вариантов перед сохранением.");
      if (personLookup.failed || !personLookup.selected)
        throw Error("Выберите волонтёра из загруженного списка.");
      await write("/participation", {
        user_id: Number(data.get("user_id")),
        opportunity_id: data.get("opportunity_id")
          ? Number(data.get("opportunity_id"))
          : null,
        title: data.get("title").trim(),
        participated_on: data.get("participated_on"),
        hours: Number(data.get("hours")),
        note: data.get("note").trim(),
      });
      dialog.close();
      toast("Участие записано. Волонтёр увидит часы в своём кабинете.");
      await renderRoute();
    },
  );
  const form = dialog.querySelector("#dialog-form");
  eventLookup = createLookup(
    form.querySelector('[data-lookup="opportunity_id"]'),
    {
      selectedItem: chosen,
      emptyLabel: "Другая волонтёрская задача",
      label: (event) => `${event.title}${event.city ? " · " + event.city : ""}`,
      load: (filters) => api(`/opportunities?${queryString(filters)}`),
      onChange: (event) => {
        form.elements.title.value = event?.title || "";
        if (event?.starts_at)
          form.elements.participated_on.value = dateOnly(event.starts_at);
        void personLookup.reload({
          reset: true,
          clear: true,
          clearSearch: true,
        });
      },
    },
  );
  personLookup = createLookup(form.querySelector('[data-lookup="user_id"]'), {
    selectedItem: person,
    emptyLabel: "Выберите волонтёра",
    label: (user) => `${user.full_name}${user.email ? " · " + user.email : ""}`,
    load: async (filters) => {
      const event = eventLookup.selected;
      if (!event)
        return api(`/users?${queryString({ ...filters, role: "volunteer" })}`);
      const data = await api(
        `/opportunities/${event.id}/participants?${queryString({ ...filters, status: "accepted" })}`,
      );
      return {
        ...data,
        items: pageItems(data).map((item) => ({ ...item, id: item.user_id })),
      };
    },
  });
  await Promise.all([eventLookup.reload(), personLookup.reload()]);
}

function kistikCard() {
  return `<article class="card kistik-card"><img src="${figmaAsset("kistik.svg")}" width="120" height="120" alt="Кистик с кистью"><h3>Кистик рядом</h3><p class="muted">Поможет найти нужный раздел, разобраться с анкетой и подготовиться к первой встрече.</p><a class="text-link" href="#kistik">Задать вопрос Кистику →</a></article>`;
}

async function renderKistik(set) {
  if (!set) {
    const token = ++state.view;
    clearInterval(state.verificationTimer);
    clearInterval(state.loginVerificationTimer);
    app.innerHTML = `<div class="public-page">${publicHeader()}<main id="content" class="content kistik-public-content" tabindex="-1"></main>${publicFooter()}</div>`;
    const content = app.querySelector("#content");
    set = (html) => {
      if (state.view !== token || !content.isConnected) return false;
      content.innerHTML = html;
      return true;
    };
    set.current = () => state.view === token && content.isConnected;
  }
  return PortalKistik.render({
    set,
    api,
    user: state.user,
    page: state.kistikOrigin || "kistik",
    onContact: () => DMMessaging.openChat({ api, user: state.user }),
    onNavigate: (href) => navigate(href.slice(1)),
    onSessionExpired: expiredSession,
  });
}

async function renderDashboard(set) {
  const [participation, training, opportunities, questionnaire] =
    await Promise.all([
      api(
        `/participation?${queryString({ user_id: state.user.id, page: 1, page_size: 1 })}`,
      ),
      api("/courses/summary"),
      api(
        `/opportunities?${queryString({ status: "open", date_from: today(), page: 1, page_size: 1 })}`,
      ),
      api("/questionnaire"),
    ]);
  if (!set.current()) return;
  const next = pageItems(opportunities)[0];
  const trainingTotal = number(training.summary?.required_total),
    trainingComplete = number(training.summary?.required_completed);
  const hasProfile = Boolean(questionnaire.completed_at),
    trainingReady = trainingTotal === 0 || trainingComplete >= trainingTotal;
  const destination = !hasProfile
    ? "#questionnaire"
    : !trainingReady
      ? "#training"
      : "#opportunities";
  const title = !hasProfile
    ? "Расскажите, что вам близко"
    : !trainingReady
      ? "Познакомимся с фондом"
      : "Найдите дело по душе";
  const description = !hasProfile
    ? "Интересы, навыки и свободное время помогут координатору подобрать подходящее дело."
    : !trainingReady
      ? "Начните со знакомства с вводными материалами. К ним можно вернуться в любой момент."
      : "Посмотрите доступные встречи и отправьте отклик. Координатор поможет подготовиться.";
  set(
    `${header(`Рады видеть вас, ${state.user.full_name.split(/\s+/)[0]}`, "Здесь — ваши встречи, обучение и всё, что помогает быть рядом.")}<section class="dashboard-next soft-panel"><div><p class="section-kicker">ВАШ СЛЕДУЮЩИЙ ШАГ</p><h3>${title}</h3><p class="muted">${description}</p></div><a class="button" href="${destination}">${!hasProfile ? "Заполнить анкету" : !trainingReady ? "К обучению" : "Все возможности"}</a></section><div class="stats dashboard-stats"><div class="stat"><strong>${number(participation.summary?.total_hours).toLocaleString("ru-RU")} ч</strong><span>Ваше участие в мероприятиях</span><small>Подтверждено координатором</small></div><div class="stat"><strong>${number(participation.summary?.entries)}</strong><span>Тёплые встречи</span><small>Столько раз вы были рядом</small></div><div class="stat"><strong>${trainingComplete} / ${trainingTotal}</strong><span>Знакомство с фондом</span><small>${trainingTotal ? "Обязательные материалы изучены" : "Обязательное обучение пока не назначено"}</small></div></div><div class="dashboard-layout"><article class="card dashboard-meeting"><div class="section-heading"><h2>Ближайшие возможности</h2><a href="#opportunities">Все возможности →</a></div>${next ? `${eventImage(next, "dashboard-cover")}<div class="dashboard-meeting-body"><div><h2>${h(next.title)}</h2><p class="muted">${date(next.starts_at, true)}<br>${h([next.format, next.city].filter(Boolean).join(" · "))}</p></div><a class="button secondary" href="#opportunities/${next.id}">О встрече</a></div>` : empty("Новые встречи появятся здесь", "Посмотрите все возможности или расскажите о своих интересах.")}</article><aside class="dashboard-side">${kistikCard()}<article class="card"><p class="section-kicker">ВАШ ПРОФИЛЬ</p><h3>Ваш профиль помогает подбору</h3><p class="muted">Изменились интересы или свободное время? Обновите предпочтения.</p><a class="text-link" href="#profile">Открыть профиль →</a></article><article class="card"><h3>На связи с командой</h3><p class="muted">Ответы координатора и изменения встреч собраны в уведомлениях.</p><a class="text-link" href="#notifications">Перейти к уведомлениям →</a></article></aside></div>`,
  );
}
async function renderProfile(set) {
  if (window.PortalAccounts) return PortalAccounts.renderProfile(set);
  const [profile, questionnaire, training] = await Promise.all([
    api("/me"),
    api("/questionnaire"),
    api("/training?page=1&page_size=1"),
  ]);
  if (!set.current()) return;
  const user = profile.user;
  state.user = user;
  const complete = Boolean(questionnaire.completed_at),
    trained =
      number(training.summary?.required_total) > 0 &&
      number(training.summary?.required_completed) ===
        number(training.summary?.required_total);
  const availability = list(questionnaire.options?.weekdays)
    .filter(
      (day) =>
        number(questionnaire.questionnaire?.availability?.[day.value]) > 0,
    )
    .map(
      (day) =>
        `${day.label}: ${number(questionnaire.questionnaire.availability[day.value])} ч`,
    )
    .join(", ");
  if (
    !set(
      `${header("Мой профиль", "Расскажите, что вам близко. Так мы сможем предложить подходящие возможности.")}<div class="profile-layout"><div class="history"><form id="profile-form" class="card profile-editor"><h2>О вас</h2>${field("ФИО", "full_name", user.full_name, "text", true, 'minlength="2" maxlength="120" autocomplete="name"')}<div class="form-grid">${field("Почта", "profile_email", user.email, "email", false, "disabled")}${field("Телефон", "phone", user.phone, "tel", false, 'maxlength="40" autocomplete="tel"')}${field("Город", "city", user.city, "text", false, 'maxlength="120" autocomplete="address-level2"')}${field("Дата рождения", "birth_date", dateOnly(user.birth_date), "date", false, `min="1900-01-01" max="${today()}"`)}${select(
        "Пол (необязательно)",
        "gender",
        [
          ["unspecified", "Предпочитаю не указывать"],
          ["female", "Женский"],
          ["male", "Мужской"],
        ],
        user.gender || "unspecified",
      )}</div><p class="muted small">Чтобы изменить электронную почту, обратитесь к администратору.</p><section class="profile-section"><h2>Интересы и навыки</h2><div class="tags">${tags(user.interests) || '<span class="muted">Интересы пока не указаны</span>'}</div>${field("Что у вас получается", "skills_preview", list(user.skills).join(", "), "text", false, "readonly")}${textarea("Опыт волонтёрства", "experience_preview", user.experience || "", false, 8000)}<a class="text-link" href="#questionnaire">Изменить интересы и опыт в анкете →</a></section><section class="profile-section"><h2>Как удобно участвовать</h2><div class="form-grid">${field("Формат", "format_preview", user.participation_format || "Пока не указан", "text", false, "readonly")}${field("Регулярность", "frequency_preview", user.participation_frequency || "Пока не указана", "text", false, "readonly")}</div>${field("Удобное время", "availability_preview", availability || "Пока не указано", "text", false, "readonly")}<a class="text-link" href="#questionnaire">Обновить формат и время →</a></section><div class="form-error" role="alert"></div><div class="form-actions"><button type="submit" class="button">Сохранить изменения</button><button type="button" class="button secondary" data-action="reload">Отменить</button></div></form><form id="password-form" class="card"><h2>Пароль</h2><p class="muted">После изменения пароля остальные сеансы будут завершены.</p>${field("Текущий пароль", "current_password", "", "password", true, 'autocomplete="current-password" maxlength="128"')}${field("Новый пароль", "new_password", "", "password", true, 'autocomplete="new-password" minlength="12" maxlength="128"')}${field("Повторите новый пароль", "repeat_password", "", "password", true, 'autocomplete="new-password" minlength="12" maxlength="128"')}${formEnd("Изменить пароль")}</form></div><aside class="profile-sidebar"><article class="card profile-identity"><span class="avatar">${h(initials(user.full_name))}</span><h2>${h(user.full_name)}</h2><p class="muted">${h(roleLabels[user.role])} «Детей Марии»</p><span class="pill">${complete ? "Анкета заполнена" : "Анкета ожидает заполнения"}</span><ul class="profile-milestones"><li>${complete ? icon("check") : ""}${complete ? "Анкета заполнена" : "Расскажите о себе в анкете"}</li><li>${trained ? icon("check") : ""}${trained ? "Знакомство с материалами пройдено" : "Знакомство с материалами впереди"}</li><li><a href="#opportunities">Можно выбирать возможности →</a></li></ul></article><article class="card"><h3>Подбор становится точнее</h3><p class="muted">Укажите интересы и навыки. Ответы помогут координатору найти подходящее дело.</p><a class="button secondary" href="#questionnaire">Перейти к анкете</a></article><article class="card"><h3>Как мы держим связь</h3><p class="muted">Ответы координатора, напоминания и изменения встреч собраны в уведомлениях.</p><a class="text-link" href="#notifications">Перейти к уведомлениям →</a></article></aside></div>`,
    )
  )
    return;
  document.querySelector("#experience_preview").readOnly = true;
  bindForm(document.querySelector("#profile-form"), async (data) => {
    const response = await write(
      "/me",
      {
        full_name: data.get("full_name").trim(),
        gender: data.get("gender"),
        city: data.get("city").trim(),
        phone: data.get("phone").trim(),
        birth_date: data.get("birth_date") || null,
        // Preserve pre-questionnaire profiles; the server derives these from a saved questionnaire.
        interests: list(user.interests),
        skills: list(user.skills),
        experience: user.experience || "",
        participation_format: user.participation_format || "",
        participation_frequency: user.participation_frequency || "",
      },
      "PATCH",
    );
    if (!state.user || !idsEqual(state.user.id, user.id)) return;
    state.user = response.user;
    toast("Профиль сохранён");
    renderShell();
  });
  bindForm(document.querySelector("#password-form"), async (data, form) => {
    if (data.get("new_password") !== data.get("repeat_password"))
      throw Error("Новые пароли не совпадают.");
    const response = await write("/auth/change-password", {
      current_password: data.get("current_password"),
      password: data.get("new_password"),
    });
    state.csrf = response.csrfToken || null;
    if (!state.csrf) await refreshCSRF();
    form.reset();
    toast("Пароль изменён");
  });
}

function exportDataDialog() {
  if (!admin()) throw new APIError("Экспорт доступен администратору.", 403);
  const descriptions = {
    csv: "Таблица волонтёров для Excel: контакты, навыки, анкеты и сводные показатели участия.",
    json: "Рабочие данные кабинета для анализа или переноса, включая анкеты. Пароли и активные сессии не включаются.",
    backup:
      "Резервная копия PostgreSQL для восстановления базы. Содержит персональные данные и хеши паролей. Храните в защищённом месте. Активные сессии и незавершённые регистрации не включаются.",
  };
  openDialog(
    "Экспорт и резервная копия",
    `<p class="muted">Выберите файл и подтвердите действие своим паролем администратора.</p>${select(
      "Что выгрузить",
      "export_format",
      [
        ["csv", "Волонтёры — таблица CSV"],
        ["json", "Рабочие данные — JSON"],
        ["backup", "Резервная копия PostgreSQL (.dump)"],
      ],
      "csv",
      true,
    )}<div id="export-description" class="notice export-info">${h(descriptions.csv)}</div>${field("Пароль администратора", "export_password", "", "password", true, 'autocomplete="current-password" maxlength="128"')}<p class="muted small">Большая выгрузка может занимать до 15 минут. Доступно пять запросов на скачивание в час. Ход загрузки отображается в браузере.</p><p id="export-progress" class="muted small" role="status"></p>`,
    async (data, form) => {
      const progress = form.querySelector("#export-progress");
      progress.textContent = "Подготавливаем защищённую ссылку…";
      form.elements.export_password.value = "";
      try {
        const result = await write("/admin/exports/prepare", {
          format: data.get("export_format"),
          current_password: data.get("export_password"),
        });
        if (!result.download_url)
          throw Error("Сервер не выдал ссылку на скачивание.");
        const url = new URL(result.download_url, location.origin);
        if (
          url.origin !== location.origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^\/api\/admin\/exports\/download\/[A-Za-z0-9_-]+$/.test(
            url.pathname,
          )
        )
          throw Error("Сервер вернул некорректную ссылку на скачивание.");
        const link = document.createElement("a");
        link.href = url.href;
        link.download = "";
        link.rel = "noreferrer";
        document.body.append(link);
        link.click();
        link.remove();
        dialog.close();
        toast(
          "Запрос на скачивание передан браузеру. Проверьте список загрузок.",
        );
      } finally {
        progress.textContent = "";
      }
    },
    "Скачать файл",
  );
  dialog
    .querySelector('[name="export_format"]')
    .addEventListener("change", (event) => {
      dialog.querySelector("#export-description").textContent =
        descriptions[event.target.value];
    });
}

async function renderUsers(set, id) {
  if (id) return renderUserDetail(set, id);
  const load = () =>
    api(
      `/users?${queryString({ ...state.usersFilter, page: state.page, page_size: 50 })}`,
    );
  let data = await load();
  if (state.page > Math.max(1, number(data.pages))) {
    state.page = Math.max(1, number(data.pages));
    data = await load();
  }
  const items = list(data.items);
  if (
    !set(
      `${header("Волонтёры фонда", "Единая база команды: интересы, навыки и история участия.", admin() ? button("Экспорт и резервная копия", "export-data", "", true) : "")}<form id="users-filter" class="filters">${field("Имя или e-mail", "q", state.usersFilter.q || "", "search", false, 'placeholder="Найти человека"')}${field("Город", "city", state.usersFilter.city || "")}${field("Навык", "skill", state.usersFilter.skill || "")}${select(
        "Статус",
        "status",
        [
          ["", "Все статусы"],
          ["new", "Новые"],
          ["active", "Активные"],
          ["paused", "На паузе"],
          ["closed", "Закрытые"],
        ],
        state.usersFilter.status || "",
      )}<button class="button secondary" type="submit">Найти</button></form>${items.length ? `<div class="table-wrap"><table><thead><tr><th>Участник</th><th>Город</th><th>Навыки</th><th>Статус</th><th>Роль</th><th></th></tr></thead><tbody>${items.map((user) => `<tr><td class="content-cell"><strong>${h(user.full_name)}</strong><div class="muted">${h(user.email)}</div></td><td class="content-cell">${h(user.city || "—")}</td><td class="description-cell"><div class="tags">${tags(list(user.skills).slice(0, 3)) || "—"}</div></td><td>${statusPill(user.status)}</td><td>${h(roleLabels[user.role])}</td><td><a class="button secondary compact" href="#users/${user.id}">Карточка →</a></td></tr>`).join("")}</tbody></table></div>` : empty("Ничего не найдено", "Измените фильтры или дождитесь новых регистраций.")}<div class="pagination"><span>Найдено: ${number(data.total ?? items.length)} · Страница ${number(data.page) || 1} из ${Math.max(1, number(data.pages))}</span><div class="actions"><button type="button" class="button secondary compact" data-action="users-prev" ${state.page <= 1 ? "disabled" : ""}>← Назад</button><button type="button" class="button secondary compact" data-action="users-next" ${state.page >= number(data.pages || 1) ? "disabled" : ""}>Далее →</button></div></div>`,
    )
  )
    return;
  document.querySelector("#users-filter").onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.usersFilter = Object.fromEntries(
      [...data].map(([key, value]) => [key, value.trim()]),
    );
    state.page = 1;
    renderRoute();
  };
}
async function renderUserDetail(set, id) {
  const sections = ["participation", "applications", "training", "notes"];
  const key = (name) => `user:${id}:${name}`;
  const historyQuery = {
    page_size: 50,
    ...Object.fromEntries(
      sections.map((name) => [`${name}_page`, listView(key(name)).page]),
    ),
  };
  let data = await api(
    `/users/${encodeURIComponent(id)}?${queryString(historyQuery)}`,
  );
  let changed = false;
  for (const name of sections) {
    const pages = Math.max(1, number(data[name]?.pages));
    if (listView(key(name)).page > pages) {
      listView(key(name)).page = pages;
      historyQuery[`${name}_page`] = pages;
      changed = true;
    }
  }
  if (changed)
    data = await api(
      `/users/${encodeURIComponent(id)}?${queryString(historyQuery)}`,
    );
  const user = data.user;
  const participations = pageItems(data.participation),
    applications = pageItems(data.applications),
    training = pageItems(data.training),
    notes = pageItems(data.notes);
  const hours = number(data.summary?.total_hours);
  const historyPager = (name) => pagination(data[name], key(name));
  if (
    !set(
      `<a class="back-link" href="#users">← База волонтёров</a><div class="page-heading"><div class="profile-summary"><span class="avatar" aria-hidden="true">${h(initials(user.full_name))}</span><div><h1>${h(user.full_name)}</h1><div class="tags">${statusPill(user.status)}<span class="pill">${h(roleLabels[user.role])}</span></div></div></div><div class="actions"><a class="button secondary" href="#questionnaire/${user.id}">Анкета волонтёра</a>${user.role === "volunteer" ? `${button("Записать участие", "user-hours", `data-user="${user.id}"`)}${button("Поблагодарить", "send-thanks", `data-user="${user.id}"`, true)}` : ""}</div></div><div class="stats"><div class="stat"><span>Часов участия</span><strong>${hours.toLocaleString("ru-RU")}</strong></div><div class="stat"><span>Участий</span><strong>${number(data.summary?.participation_count ?? data.participation?.total)}</strong></div><div class="stat"><span>Откликов</span><strong>${number(data.summary?.application_count ?? data.applications?.total)}</strong></div></div><div class="two-column"><div class="history"><article class="card"><h2>О волонтёре</h2><dl class="details"><div><dt>Почта</dt><dd>${h(user.email)}</dd></div><div><dt>Телефон</dt><dd>${h(user.phone || "Не указан")}</dd></div><div><dt>Город</dt><dd>${h(user.city || "Не указан")}</dd></div><div><dt>Регистрация</dt><dd>${date(user.created_at)}</dd></div>${manager() ? `<div><dt>Дата рождения</dt><dd>${date(user.birth_date)}</dd></div>` : ""}<div><dt>Формат / регулярность</dt><dd>${h([user.participation_format, user.participation_frequency].filter(Boolean).join(" · ") || "Не указаны")}</dd></div><div class="full"><dt>Навыки</dt><dd class="tags">${tags(user.skills) || "Не указаны"}</dd></div><div class="full"><dt>Интересы</dt><dd class="tags">${tags(user.interests) || "Не указаны"}</dd></div><div class="full"><dt>Опыт</dt><dd class="preserve">${h(user.experience || "Пока не заполнен")}</dd></div>${manager() ? `<div><dt>Правила приняты</dt><dd>${date(user.rules_accepted_at, true)}</dd></div><div><dt>Ознакомление с политикой</dt><dd>${date(user.privacy_accepted_at, true)}</dd></div>` : ""}</dl></article><article class="card"><h2>История участия</h2>${participations.length ? `<div class="history">${participations.map((item) => `<div class="history-item"><div class="row between"><strong>${h(item.title || item.opportunity_title)}</strong><span class="pill">${h(item.hours)} ч.</span></div><p class="muted small">${date(item.participated_on)}</p>${item.note ? `<p class="preserve">${h(item.note)}</p>` : ""}</div>`).join("")}</div>` : '<p class="muted">Подтверждённых участий пока нет.</p>'}${historyPager("participation")}</article><article class="card"><h2>Отклики</h2>${applications.length ? `<div class="list">${applications.map((item) => `<div class="list-item"><a href="#opportunities/${item.opportunity_id}">${h(item.opportunity_title || item.title)}</a>${statusPill(item.status)}</div>`).join("")}</div>` : '<p class="muted">Откликов пока нет.</p>'}${historyPager("applications")}</article></div><aside class="history"><form class="card" id="status-form"><h3>Статус в команде</h3>${select(
        "Статус волонтёра",
        "user_status",
        [
          ["new", "Новый"],
          ["active", "Активен"],
          ["paused", "Пауза"],
          ["closed", "Закрыт"],
        ],
        user.status,
      )}<p class="muted small">Закрытый аккаунт не сможет войти в кабинет.</p>${formEnd("Обновить статус")}</form>${admin() ? `<form class="card" id="role-form"><h3>Права доступа</h3>${select("Роль", "user_role", Object.entries(roleLabels), user.role, true, idsEqual(user.id, state.user.id) ? "disabled" : "")}${idsEqual(user.id, state.user.id) ? '<p class="muted small">Свою роль изменить нельзя.</p>' : formEnd("Назначить роль")}</form>` : ""}<article class="card"><h3>Обучение</h3>${training.length ? `<div class="list">${training.map((item) => `<div class="list-item"><div><strong>${h(item.title)}</strong><div class="muted small">${item.required ? "Обязательное" : "Дополнительное"}</div></div><span class="pill ${item.completed || item.completed_at ? "success" : ""}">${item.completed || item.completed_at ? "Ознакомился(-ась)" : "Не отмечено"}</span></div>`).join("")}</div>` : '<p class="muted">Материалы ещё не добавлены.</p>'}${historyPager("training")}</article>${manager() ? `<article class="card"><h3>Заметки руководителей</h3><p class="muted small">Доступны руководителям и администраторам.</p><div class="history">${notes.map((note) => `<div class="history-item"><p class="preserve">${h(note.body)}</p><p class="muted small">${h(note.author_name || note.full_name || "")} · ${date(note.created_at, true)}</p></div>`).join("") || '<p class="muted">Заметок пока нет.</p>'}</div>${historyPager("notes")}<form id="note-form">${textarea("Новая заметка", "body", "", true, 4000)}${formEnd("Добавить заметку")}</form></article>` : ""}</aside></div>`,
    )
  )
    return;
  if (user.role === "volunteer" || admin()) {
    bindForm(document.querySelector("#status-form"), async (form) => {
      await write(
        `/users/${id}/status`,
        { status: form.get("user_status") },
        "PATCH",
      );
      toast("Статус обновлён");
      await renderRoute();
    });
  } else {
    document.querySelector("#status-form").innerHTML =
      `<h3>Статус сотрудника</h3>${statusPill(user.status)}<p class="muted small">Изменить статус сотрудника может администратор.</p>`;
  }
  if (admin() && !idsEqual(user.id, state.user.id))
    bindForm(document.querySelector("#role-form"), async (form) => {
      await write(
        `/users/${id}/role`,
        { role: form.get("user_role") },
        "PATCH",
      );
      toast("Роль назначена");
      await renderRoute();
    });
  if (manager())
    bindForm(document.querySelector("#note-form"), async (form) => {
      await write(`/users/${id}/notes`, { body: form.get("body").trim() });
      listView(key("notes")).page = 1;
      toast("Заметка добавлена");
      await renderRoute();
    });
}

async function renderAnalytics(set) {
  const data = await api("/analytics");
  const volunteers = list(data.users).filter(
    (item) => item.role === "volunteer",
  );
  const total = volunteers.reduce((sum, item) => sum + number(item.count), 0);
  const active = volunteers
    .filter((item) => item.status === "active")
    .reduce((sum, item) => sum + number(item.count), 0);
  const chart = (items, labelKey, countKey = "count") => {
    const max = Math.max(1, ...items.map((item) => number(item[countKey])));
    return (
      items
        .map(
          (item) =>
            `<div class="chart-row"><span>${h(item[labelKey])}</span><strong>${number(item[countKey]).toLocaleString("ru-RU")}</strong><progress max="${max}" value="${number(item[countKey])}" aria-label="${h(item[labelKey])}"></progress></div>`,
        )
        .join("") || '<p class="muted">Пока нет данных.</p>'
    );
  };
  const registrations = list(data.registrations).map((item) => ({
    ...item,
    label: date(item.month),
  }));
  const statuses = volunteers.map((item) => ({
    ...item,
    label: statusLabels[item.status] || item.status,
  }));
  const events = Array.isArray(data.opportunities)
    ? data.opportunities.map((item) => ({
        ...item,
        label: statusLabels[item.status] || item.status,
      }))
    : [];
  set(
    `${header("Сводка фонда", "Общая картина команды и подтверждённого волонтёрского участия.", "", "Руководителю")}<div class="stats analytics-stats"><div class="stat"><span>Волонтёров</span><strong>${total}</strong><span>в базе фонда</span></div><div class="stat"><span>Активных волонтёров</span><strong>${active}</strong><span>со статусом «Активен»</span></div><div class="stat highlight"><span>Волонтёрских часов</span><strong>${number(data.hours?.total_hours).toLocaleString("ru-RU")}</strong><span>подтверждено сотрудниками</span></div><div class="stat"><span>Участий</span><strong>${number(data.hours?.entries)}</strong><span>зарегистрировано в системе</span></div></div><div class="grid analytics-grid"><article class="card"><h2>Статусы волонтёров</h2>${chart(statuses, "label")}</article><article class="card"><h2>География команды</h2>${chart(list(data.cities), "city")}</article><article class="card"><h2>Новые регистрации</h2><p class="muted small">За последние 12 месяцев</p>${chart(registrations, "label")}</article>${events.length ? `<article class="card"><h2>События</h2>${chart(events, "label")}</article>` : ""}</div>`,
  );
}
function notificationTarget(item) {
  if (item.target_type === "group" && /^\d+$/.test(String(item.target_id)))
    return { route: `groups/${item.target_id}`, label: "Открыть разговор" };
  if (item.target_type === "chat")
    return { action: "open-chat", attrs: "", label: "Открыть сообщения" };
  if (
    item.target_type === "inbox" &&
    manager() &&
    /^\d+$/.test(String(item.target_id))
  )
    return { route: `messages/${item.target_id}`, label: "Открыть диалог" };
  if (item.target_type === "event" && /^\d+$/.test(String(item.target_id)))
    return {
      route: `opportunities/${item.target_id}`,
      label: item.action_label || "Посмотреть мероприятие",
    };
  if (
    ["dashboard", "opportunities", "training", "questionnaire"].includes(
      item.target_type,
    )
  )
    return { route: item.target_type, label: item.action_label || "Перейти" };
  return null;
}
function notificationLink(item) {
  const target = notificationTarget(item);
  if (!target) return "";
  return button(
    target.label,
    "notification-open",
    `data-id="${item.id}" ${target.route ? `data-route="${h(target.route)}"` : 'data-chat="true"'}`,
    true,
  );
}
async function renderNotifications(set) {
  const loadPage = () =>
    api(
      `/notifications?${queryString({ page: state.notificationsPage, page_size: 50, unread: state.notificationsUnreadOnly })}`,
    );
  let data = await loadPage();
  if (state.notificationsPage > Math.max(1, number(data.pages))) {
    state.notificationsPage = Math.max(1, number(data.pages));
    data = await loadPage();
  }
  const items = pageItems(data),
    page = number(data.page) || 1,
    pages = Math.max(1, number(data.pages)),
    unread = number(data.unread);
  set(
    `${header("Уведомления", "Новые возможности, важные изменения и сообщения команды — в одном месте.", button("Отметить все прочитанными", "read-all-notifications", unread ? "" : "disabled", true))}<div class="notification-filters" role="group" aria-label="Показать уведомления"><button type="button" class="pill ${!state.notificationsUnreadOnly ? "selected" : ""}" data-action="notification-filter" data-unread="false" aria-pressed="${!state.notificationsUnreadOnly}">Все${!state.notificationsUnreadOnly ? " · " + number(data.total) : ""}</button><button type="button" class="pill ${state.notificationsUnreadOnly ? "selected" : ""}" data-action="notification-filter" data-unread="true" aria-pressed="${state.notificationsUnreadOnly}">Непрочитанные · ${unread}</button></div><div class="notification-list">${items.length ? items.map((item) => `<article class="notification ${!item.read_at ? "unread" : ""}"><span class="notification-symbol">${icon("mail")}</span><div class="notification-body"><p class="section-kicker">СООБЩЕНИЕ КОМАНДЫ</p><h3>${h(item.title || "Обновление в кабинете")}</h3><p class="preserve">${h(item.body || item.message)}</p>${notificationLink(item)}</div><div class="notification-meta"><span class="notification-state">${item.read_at ? "Прочитано" : "● Непрочитанное"}</span>${!item.read_at ? button("Отметить прочитанным", "read-notification", `data-id="${item.id}"`, true) : ""}<time class="muted small">${date(item.created_at, true)}</time></div></article>`).join("") : empty(state.notificationsUnreadOnly ? "Непрочитанных уведомлений нет" : "Вы всё знаете", state.notificationsUnreadOnly ? "Переключитесь на все уведомления, чтобы посмотреть историю." : "Здесь появятся сообщения о ваших откликах и участии.")}</div><div class="pagination"><span>Найдено: ${number(data.total)} · Страница ${page} из ${pages}</span><div class="actions">${button("← Назад", "notification-page", `data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}`, true)}${button("Далее →", "notification-page", `data-page="${page + 1}" ${page >= pages ? "disabled" : ""}`, true)}</div></div>`,
  );
}

async function renderThanks(set) {
  const data = await loadList("/thanks", "thanks");
  const items = pageItems(data);
  set(
    `${header("Спасибо, что вы рядом", "Благодарности команды за ваше время, заботу и участие.", "", "Ваш вклад замечают")}${items.length ? `<div class="grid">${items.map((item) => `<article class="card"><span class="pill success">♡ Благодарность</span><h3>${h(item.sender_name || item.author_name || "От команды фонда")}</h3><p class="preserve">${h(item.message || item.body)}</p><p class="muted small">${date(item.created_at)}</p></article>`).join("")}</div>` : empty("Первое «спасибо» ещё впереди", "Когда координатор отправит вам благодарность, она сохранится здесь.")}${pagination(data, "thanks")}`,
  );
}
async function renderAudit(set) {
  const data = await loadList("/audit", "audit");
  const items = pageItems(data);
  const actions = {
    create: "Создание",
    archive: "Удаление в корзину",
    restore: "Восстановление из корзины",
    course_archive: "Удаление курса в корзину",
    course_restore: "Восстановление курса",
    update: "Изменение",
    change_role: "Изменение роли",
    change_status: "Изменение статуса",
    complete: "Ознакомление",
    apply: "Отклик",
    register: "Регистрация",
    operator_create_test_volunteer: "Создание тестового волонтёра",
    create_opportunity: "Создание события",
    update_opportunity: "Изменение события",
    change_application_status: "Изменение отклика",
    create_participation: "Запись участия",
    update_participation: "Исправление участия",
    create_training: "Добавление материала",
    update_training: "Изменение материала",
    update_profile: "Изменение профиля",
    add_note: "Заметка",
    send_thanks: "Благодарность",
    change_password: "Изменение пароля",
    complete_questionnaire: "Заполнение анкеты",
    save_questionnaire_draft: "Сохранение черновика анкеты",
    create_staff_task: "Создание задачи команды",
    update_staff_task: "Изменение задачи команды",
    invite: "Приглашение на мероприятие",
    revoke: "Отзыв приглашения",
    withdraw_invitation: "Отзыв заявки вместе с приглашением",
    admin_export_started: "Начало выгрузки",
    admin_export_completed: "Выгрузка завершена",
    admin_export_ready: "Файл выгрузки подготовлен",
    admin_export_failed: "Ошибка выгрузки",
    admin_export_password_rejected: "Неверный пароль при выгрузке",
  };
  const subjects = {
    user: "Пользователь",
    opportunity: "Событие",
    course: "Курс",
    application: "Отклик",
    participation: "Участие",
    training: "Обучение",
    training_material: "Материал",
    note: "Заметка",
    thanks: "Благодарность",
    staff_task: "Задача команды",
    opportunity_invitation: "Приглашение",
    export_backup: "Резервная копия PostgreSQL",
    export_json: "Рабочие данные JSON",
    export_csv: "Волонтёры CSV",
  };
  set(
    `${header("Журнал действий", "Последние изменения, выполненные пользователями системы.", button("Экспорт и резервная копия", "export-data", "", true))}${items.length ? `<div class="table-wrap"><table><thead><tr><th>Когда</th><th>Сотрудник</th><th>Действие</th><th>Объект</th></tr></thead><tbody>${items.map((item) => `<tr><td>${date(item.created_at, true)}</td><td class="content-cell">${h(item.actor_name || item.full_name || "Система")}</td><td class="content-cell">${h(actions[item.action] || item.action)}</td><td class="content-cell">${h(subjects[item.subject_type] || item.subject_type)} ${item.subject_id ? "#" + h(item.subject_id) : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("Изменений пока нет", "Действия команды будут сохраняться здесь.")}${pagination(data, "audit")}`,
  );
}

async function handleAction(element) {
  if (element.dataset.action === "show-password") {
    const input = document.getElementById(element.dataset.field);
    if (!input) return;
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    element.textContent = visible ? "Скрыть пароль" : "Показать пароль";
    element.setAttribute("aria-pressed", String(visible));
    return;
  }
  if (element.dataset.action === "change-password")
    return PortalAccounts.changePassword();
  if (element.dataset.action === "open-chat") {
    PortalUI.closePublicMenu();
    PortalUI.closeShell();
    return window.DMMessaging?.openChat({
      api,
      user: state.user,
      eventId: element.dataset.event,
    });
  }
  const action = element.dataset.action;
  const id = element.dataset.id;
  const viewToken = state.view;
  const hash = location.hash;
  // Late actions must not redraw a new route or open a dialog in another account.
  const current = () =>
    state.view === viewToken && location.hash === hash && element.isConnected;
  if (action === "shell-menu") return PortalUI.toggleShell();
  if (action.startsWith("org-"))
    return PortalOrganizer.handleAction(action, element);
  if (action === "reset-events") {
    state.listViews.opportunities = { page: 1 };
    return renderRoute();
  }
  if (action === "remove-event-filter") {
    const name = element.dataset.filter;
    if (!opportunityFilterNames.includes(name)) return;
    const view = listView("opportunities");
    delete view[name];
    view.page = 1;
    return renderRoute();
  }
  if (action === "public-menu") return PortalUI.togglePublicMenu();
  if (action === "home-section") {
    const section = ["about", "directions", "start"].includes(
      element.dataset.section,
    )
      ? element.dataset.section
      : "about";
    if (document.querySelector(".home-page")) {
      scrollHomeSection(section);
      return;
    }
    state.homeSection = section;
    return navigate("home");
  }
  if (action === "login-method") {
    const emailInput =
      document.querySelector("#email") ||
      document.querySelector("#login_code_email");
    if (emailInput) state.loginEmail = emailInput.value.trim();
    state.loginMode = element.dataset.mode === "password" ? "password" : "code";
    if (location.hash === "#login") return renderLogin();
    return navigate("login");
  }
  if (action === "resend-login-code") return resendLoginCode();
  if (action === "login-view") return navigate("login");
  if (action === "register-view") return navigate("register");
  if (action === "verify-view") return navigate("verify");
  if (action === "resend-verification") return resendVerification();
  if (action === "export-data") return exportDataDialog();
  if (action === "close-dialog") return dialog.close();
  if (action === "retry-boot") return boot();
  if (action === "reload") return renderRoute();
  if (action === "list-page") {
    listView(element.dataset.list).page = Math.max(
      1,
      number(element.dataset.page),
    );
    return renderRoute();
  }
  if (action === "logout") {
    if (!(await PortalUI.allowLeave())) return;
    ++state.view;
    await write("/auth/logout");
    clearModuleState();
    state.user = null;
    state.csrf = null;
    state.afterLogin = null;
    state.loginVerification = null;
    state.verification = null;
    clearInterval(state.verificationTimer);
    clearInterval(state.loginVerificationTimer);
    return navigate("home");
  }
  if (action === "new-event" || action === "edit-event")
    return navigate(`event-editor/${action === "edit-event" ? id : "new"}`);
  if (action === "event-login") {
    state.afterLogin = `opportunities/${id}`;
    return navigate("login");
  }
  if (action === "apply") {
    const event = state.events.get(String(id));
    return openDialog(
      "Откликнуться на событие",
      `<p><strong>${h(event?.title || "Волонтёрское событие")}</strong></p>${textarea("Сообщение координатору (необязательно)", "note", "", false, 1000)}`,
      async (data) => {
        await write(`/opportunities/${id}/apply`, {
          note: data.get("note").trim(),
        });
        if (!current()) return;
        dialog.close();
        toast("Отклик отправлен координатору");
        await renderRoute();
      },
      "Отправить отклик",
    );
  }
  if (action === "application-status") {
    const targetStatus = element.dataset.status;
    if (targetStatus === "withdrawn" || targetStatus === "rejected")
      return openDialog(
        targetStatus === "withdrawn" ? "Отозвать отклик?" : "Отклонить отклик?",
        `<p class="muted">${targetStatus === "withdrawn" ? "Координатор увидит, что вы отменили своё участие." : "Волонтёр увидит новый статус в кабинете."}</p>`,
        async () => {
          await write(`/applications/${id}`, { status: targetStatus }, "PATCH");
          if (!current()) return;
          dialog.close();
          toast("Статус отклика обновлён");
          await renderRoute();
        },
        targetStatus === "withdrawn" ? "Отозвать" : "Отклонить",
      );
    await write(`/applications/${id}`, { status: targetStatus }, "PATCH");
    if (!current()) return;
    toast("Участие подтверждено");
    return renderRoute();
  }
  if (action === "new-training" || action === "edit-training")
    return trainingDialog(action === "edit-training" ? id : null);
  if (action === "complete-training") {
    await write(`/training/${id}/complete`);
    if (!current()) return;
    toast("Ознакомление с материалом отмечено");
    return renderRoute();
  }
  if (action === "new-hours") return hoursDialog();
  if (action === "edit-hours") return hoursDialog({ id });
  if (action === "event-hours")
    return hoursDialog({
      eventId: element.dataset.event,
      userId: element.dataset.user,
    });
  if (action === "user-hours")
    return hoursDialog({ userId: element.dataset.user });
  if (action === "users-prev") {
    state.page = Math.max(1, state.page - 1);
    return renderRoute();
  }
  if (action === "users-next") {
    state.page++;
    return renderRoute();
  }
  if (action === "send-thanks")
    return openDialog(
      "Поблагодарить волонтёра",
      textarea("За что хочется сказать спасибо", "message", "", true, 2000),
      async (data) => {
        await write(`/users/${element.dataset.user}/thanks`, {
          message: data.get("message").trim(),
        });
        dialog.close();
        toast("Благодарность отправлена в кабинет волонтёра");
      },
      "Отправить благодарность",
    );
  if (action === "notification-filter") {
    state.notificationsUnreadOnly = element.dataset.unread === "true";
    state.notificationsPage = 1;
    return renderRoute();
  }
  if (action === "notification-page") {
    state.notificationsPage = Math.max(1, number(element.dataset.page));
    return renderRoute();
  }
  if (action === "read-all-notifications") {
    const result = await write("/notifications/read-all", {});
    if (!current()) return;
    state.notificationsPage = 1;
    toast(`Отмечено прочитанными: ${number(result.marked)}`);
    return renderRoute();
  }
  if (action === "notification-open") {
    await write(`/notifications/${id}/read`, {}, "PATCH");
    if (!current()) return;
    refreshBadge();
    if (element.dataset.chat)
      return DMMessaging.openChat({ api, user: state.user });
    if (
      /^(dashboard|opportunities|training|questionnaire|messages|groups)(\/\d+)?$/.test(
        element.dataset.route || "",
      )
    )
      navigate(element.dataset.route);
    return;
  }
  if (action === "read-notification") {
    await write(`/notifications/${id}/read`, {}, "PATCH");
    if (!current()) return;
    return renderRoute();
  }
}
document.addEventListener("click", async (event) => {
  const element = event.target.closest("[data-action]");
  if (!element || element.disabled) return;
  if (
    element.tagName === "A" &&
    element.getAttribute("href") === location.hash &&
    !element.dataset.action
  ) {
    event.preventDefault();
    return;
  }
  if (element.dataset.action === "home-section") {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    // The section handler owns navigation; a native hash change would redraw home.
    event.preventDefault();
  }
  element.disabled = true;
  try {
    await handleAction(element);
  } catch (error) {
    if (error.status === 401 && state.user) expiredSession();
    else toast(error.message, true);
  } finally {
    element.disabled =
      (element.dataset.action === "resend-verification" &&
        (state.config.email_verification_available !== true ||
          Boolean(state.verificationSending) ||
          number(state.verification?.resendAt) > Date.now())) ||
      (element.dataset.action === "resend-login-code" &&
        ((state.config.email_login_available !== true &&
          !(
            demoLoginChallenge() &&
            state.config.email_demo_login_available === true
          )) ||
          Boolean(state.loginVerificationSending) ||
          number(state.loginVerification?.resendAt) > Date.now()));
  }
});
window.addEventListener("hashchange", async () => {
  if (!(await PortalUI.beforeRoute())) return;
  window.PortalCourses?.destroy();
  window.DMMessaging?.deactivate();
  window.PortalCommunity?.deactivate();
  window.PortalKistik?.destroy();
  if (dialog.open) dialog.close();
  window.scrollTo({ top: 0, behavior: "instant" });
  renderShell();
});

async function boot() {
  app.innerHTML =
    '<main class="startup" role="status">Открываем кабинет…</main>';
  try {
    const [config] = await Promise.all([api("/config"), refreshCSRF()]);
    state.config = config;
    try {
      const data = await api("/me");
      state.user = data.user;
      renderShell();
    } catch (error) {
      if (error.status === 401) {
        state.user = null;
        renderShell();
      } else throw error;
    }
  } catch (error) {
    app.innerHTML = `<main id="content" class="startup">${brand()}<h1>Не удалось открыть кабинет</h1>${errorHTML(error)}${button("Повторить", "retry-boot")}</main>`;
  }
}
boot();
