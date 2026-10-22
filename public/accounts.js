"use strict";

window.PortalAccounts = (() => {
  const passwordField = (label, name, current = false) =>
    `<div class="password-control">${field(label, name, "", "password", true, `autocomplete="${current ? "current-password" : "new-password"}" ${current ? "" : 'minlength="12"'} maxlength="128"`)}<button type="button" class="password-toggle text-link" data-action="show-password" data-field="${name}" aria-controls="${name}" aria-pressed="false">Показать пароль</button></div>`;
  const passwordHelp =
    '<p class="password-help muted small">От 12 до 128 символов. Можно использовать слова, цифры, пробелы и символы любого языка.</p>';
  function clearTimers() {
    state.view++;
    clearInterval(state.verificationTimer);
    clearInterval(state.loginVerificationTimer);
  }
  function rememberEmail() {
    const input = document.querySelector('#auth-form [name="email"]');
    if (input) state.loginEmail = input.value.trim();
  }
  function currentForm(form, viewToken, hash) {
    return (
      form.isConnected && state.view === viewToken && location.hash === hash
    );
  }
  async function writeForForm(form, viewToken, hash, path, payload) {
    try {
      return await write(path, payload);
    } catch (error) {
      if (currentForm(form, viewToken, hash)) throw error;
      return null;
    }
  }
  function renderLogin(info = "") {
    clearTimers();
    const viewToken = state.view,
      hash = location.hash;
    const canMail = state.config.email_login_available === true;
    const canCode = loginCodeAvailable();
    const codeMode = state.loginMode !== "password" && canCode;
    const email = state.loginEmail || state.loginVerification?.email || "";
    app.innerHTML = authLayout(
      `<p class="section-kicker">ПРОСТРАНСТВО ВОЛОНТЁРА</p><h1>Войти в кабинет</h1><p class="muted">${codeMode ? (canMail ? "Введите почту существующего аккаунта. Для входа нужен четырёхзначный код." : "Введите почту тестового аккаунта, чтобы продолжить вход по коду.") : "Продолжим делать добрые дела вместе."}</p>${info ? `<div class="notice" role="status">${h(info)}</div>` : ""}<form id="auth-form" data-auth-mode="${codeMode ? "email-code" : "password"}">${field("Электронная почта", "email", email, "email", true, 'autocomplete="email" maxlength="254" placeholder="name@example.org"')}${codeMode ? "" : passwordField("Пароль", "password", true)}<div class="form-error" role="alert"></div><button type="submit" class="button submit" data-pending-label="${codeMode ? "Запрашиваем код…" : "Входим…"}" ${codeMode && !canCode ? "disabled" : ""}>${codeMode ? "Получить код" : "Войти"}</button>${!codeMode && state.config.password_recovery_available !== false ? '<a class="forgot-link text-link" href="#forgot-password" data-account-email>Не помню пароль</a>' : !canMail ? `<p class="muted small">${canCode ? "Отправка писем сейчас недоступна. Вход по коду доступен только для тестовых аккаунтов. Для остальных используйте пароль." : "Отправка кодов сейчас недоступна. Войдите с паролем."}</p>` : ""}</form>${canCode ? `<div class="login-method"><button type="button" class="button secondary" data-action="login-method" data-mode="${codeMode ? "password" : "code"}">${codeMode ? "Войти с паролем" : "Войти по коду"}</button></div>` : ""}<div class="auth-switch"><a href="#register" data-account-email>Ещё нет аккаунта? Создать →</a></div>`,
    );
    document
      .querySelectorAll("[data-account-email]")
      .forEach((link) => link.addEventListener("click", rememberEmail));
    const form = document.querySelector("#auth-form");
    restoreLoginError(form);
    form.elements.email.addEventListener("input", rememberEmail);
    document
      .querySelector('[data-action="login-method"]')
      ?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        rememberEmail();
        state.loginMode = codeMode ? "password" : "code";
        renderLogin();
      });
    bindForm(form, async (data) => {
      const address = String(data.get("email")).trim();
      state.loginEmail = address;
      if (!codeMode) {
        let result;
        try {
          result = await write("/auth/login", {
            email: address,
            password: data.get("password"),
          });
        } catch (error) {
          if (!currentForm(form, viewToken, hash)) return;
          if (error.status === 401)
            throw new Error(
              "Не удалось войти. Проверьте почту и пароль или войдите по коду.",
            );
          throw error;
        }
        if (!currentForm(form, viewToken, hash)) return;
        if (!result.user)
          throw Error("Не удалось завершить вход. Повторите попытку.");
        await finishLogin(result, state.afterLogin || "dashboard");
      } else {
        const result = await writeForForm(
          form,
          viewToken,
          hash,
          "/auth/login-code/request",
          { email: address },
        );
        if (!currentForm(form, viewToken, hash)) return;
        state.loginVerification = loginChallenge(result, address);
        navigate("login-code");
      }
    });
  }
  function journey() {
    return `<aside class="questionnaire-journey registration-journey"><p class="questionnaire-eyebrow">Первый шаг к знакомству</p><div class="questionnaire-intro"><h1>Давайте<br>знакомиться.</h1><p>Расскажите немного о себе.<br>Мы поможем найти подходящую роль<br>и подготовиться к первой встрече.</p></div><div class="questionnaire-stages"><h2>Этапы</h2><ol>${[
      ["Аккаунт", "Почта, пароль и подтверждение"],
      ["Анкета", "Интересы, навыки и удобное время"],
      ["Знакомство", "Команда фонда поможет начать"],
    ]
      .map(
        ([title, description], i) =>
          `<li><span class="questionnaire-stage-number">0${i + 1}</span><div><h3>${title}</h3><p>${description}</p></div></li>`,
      )
      .join(
        "",
      )}</ol></div><a class="registration-kistik" href="#kistik"><img src="/assets/figma/8c943.svg" alt="Кистик" width="110" height="110"><span>Привет! Буду помогать совершать добрые дела.<br><strong>Кистик · Помощник</strong></span></a></aside>`;
  }
  function renderRegistration(info = "") {
    clearTimers();
    const viewToken = state.view,
      hash = location.hash;
    const saved = state.registrationDraft || {},
      canRegister =
        state.config.registration_enabled &&
        state.config.email_verification_available;
    const privacy = safeURL(state.config.privacy_url),
      rules = safeURL(state.config.rules_url);
    app.innerHTML = `<div class="public-page registration-page">${publicHeader()}<main id="content" class="registration-content">${journey()}<section class="registration-card"><h2>Создать аккаунт</h2>${info ? `<p class="notice" role="status">${h(info)}</p>` : ""}<form id="auth-form" data-auth-mode="registration"><div class="form-grid">${field("Имя", "first_name", saved.first_name || "", "text", true, 'autocomplete="given-name" minlength="2" maxlength="60"')}${field("Фамилия", "last_name", saved.last_name || "", "text", false, 'autocomplete="family-name" maxlength="59"')}${field("Электронная почта", "email", saved.email || state.loginEmail || "", "email", true, 'autocomplete="email" maxlength="254"')}${field("Телефон · необязательно", "phone", saved.phone || "", "tel", false, 'autocomplete="tel" maxlength="40" placeholder="+7 900 000-00-00"')}</div>${passwordField("Придумайте пароль", "password")}${passwordHelp}${passwordField("Повторите пароль", "repeat_password")}${check(`Согласен(-на) на обработку персональных данных и ознакомлен(-а) с ${privacy ? `<a href="${h(privacy)}" target="_blank" rel="noopener noreferrer">политикой конфиденциальности</a>` : "политикой конфиденциальности"}${rules ? ` и <a href="${h(rules)}" target="_blank" rel="noopener noreferrer">правилами пользования сайтом</a>` : ""}`, "consent", false, true)}${!canRegister ? '<p class="notice" role="status">Регистрация откроется после подключения отправки писем. Сейчас можно войти в существующий аккаунт.</p>' : ""}<div class="form-error" role="alert"></div><button class="button submit" type="submit" data-pending-label="Создаём аккаунт…" ${!canRegister ? "disabled" : ""}>Создать аккаунт →</button><a class="registration-login text-link" href="#login">Уже с нами? Войти в кабинет</a></form></section></main></div>`;
    const form = document.querySelector("#auth-form");
    const savePublic = () => {
      state.registrationDraft = Object.fromEntries(
        ["first_name", "last_name", "email", "phone"].map((name) => [
          name,
          form.elements[name].value,
        ]),
      );
      state.loginEmail = form.elements.email.value.trim();
    };
    form.addEventListener("input", savePublic);
    bindForm(form, async (data) => {
      if (!canRegister) throw Error("Регистрация пока недоступна.");
      savePublic();
      if (data.get("password") !== data.get("repeat_password"))
        throw Error("Пароли не совпадают.");
      const phone = String(data.get("phone")).trim();
      if (phone && !/^\+?[\d\s()\-]{7,40}$/.test(phone))
        throw Error("Проверьте номер телефона.");
      const result = await writeForForm(
        form,
        viewToken,
        hash,
        "/auth/register",
        {
          full_name: [
            data.get("first_name").trim(),
            data.get("last_name").trim(),
          ]
            .filter(Boolean)
            .join(" "),
          email: data.get("email").trim(),
          phone: phone.replace(/[\s()\-]/g, ""),
          password: data.get("password"),
          rules_accepted: data.has("consent"),
          privacy_accepted: data.has("consent"),
        },
      );
      form
        .querySelectorAll(
          'input[type="password"],input[autocomplete="new-password"]',
        )
        .forEach((input) => (input.value = ""));
      if (!currentForm(form, viewToken, hash)) return;
      if (result.verification_required) {
        state.verification = {
          email: result.email || state.registrationDraft.email,
          resendAt: Date.now() + number(result.resend_after || 30) * 1000,
          expiresAt: Date.now() + number(result.expires_in || 600) * 1000,
        };
        navigate("verify");
      } else if (result.user) await finishLogin(result, "questionnaire");
      else
        throw Error(
          "Проверьте почту — мы отправили инструкции для продолжения.",
        );
    });
  }
  function renderRecovery(token = "") {
    clearTimers();
    const viewToken = state.view,
      hash = location.hash;
    if (!token && state.config.password_recovery_available === false) {
      app.innerHTML = authLayout(
        `<p class="section-kicker">ВОССТАНОВЛЕНИЕ ДОСТУПА</p><h1>Восстановление доступа</h1><p class="muted">Отправка писем сейчас недоступна. Используйте пароль или доступный способ входа.</p><a class="button" href="#login">Перейти ко входу</a>`,
      );
      state.loginMode = loginCodeAvailable() ? "code" : "password";
      return;
    }
    const reset = Boolean(token);
    app.innerHTML = authLayout(
      `<p class="section-kicker">${reset ? "НОВЫЙ ПАРОЛЬ" : "ВОССТАНОВЛЕНИЕ ДОСТУПА"}</p><h1>${reset ? "Вернитесь к добрым делам" : "Забыли пароль?"}</h1><p class="muted">${reset ? "Вы перешли по ссылке из письма. Задайте новый пароль для аккаунта." : "Укажите почту вашего аккаунта. Отправим письмо со ссылкой для смены пароля."}</p><form id="recovery-form">${reset ? `${passwordField("Новый пароль", "new_password")}${passwordHelp}${passwordField("Повторите новый пароль", "repeat_password")}` : field("Электронная почта", "email", state.loginEmail || "", "email", true, 'autocomplete="email" maxlength="254"')}<div class="form-error" role="alert"></div><button class="button submit" type="submit" data-pending-label="Подождите…">${reset ? "Сохранить пароль" : "Отправить ссылку"}</button></form><a class="text-link recovery-back" href="#login">← Вернуться ко входу</a>`,
    );
    const recoveryForm = document.querySelector("#recovery-form");
    recoveryForm.elements.email?.addEventListener("input", () => {
      state.loginEmail = recoveryForm.elements.email.value.trim();
    });
    bindForm(recoveryForm, async (data, form) => {
      if (reset) {
        if (data.get("new_password") !== data.get("repeat_password"))
          throw Error("Пароли не совпадают.");
        await writeForForm(
          form,
          viewToken,
          hash,
          "/auth/password-reset/complete",
          { token, password: data.get("new_password") },
        );
        if (!currentForm(form, viewToken, hash)) return;
        form.reset();
        state.user = null;
        state.loginMode = "password";
        window.PortalOrganizer?.reset();
        window.DMMessaging?.destroy();
        window.PortalCommunity?.destroy();
        window.PortalCourses?.destroy();
        history.replaceState(null, "", "#login");
        PortalUI.syncHash();
        renderLogin(
          "Пароль обновлён. Теперь можно войти с новым паролем или по коду.",
        );
      } else {
        state.loginEmail = data.get("email").trim();
        const result = await writeForForm(
          form,
          viewToken,
          hash,
          "/auth/password-reset/request",
          { email: state.loginEmail },
        );
        if (!currentForm(form, viewToken, hash)) return;
        form.innerHTML = `<div class="notice success" role="status">${h(result.message)}</div><p class="muted">Проверьте входящие и папку «Спам». Ссылка действует 10 минут.</p>`;
      }
    });
  }
  function changePassword() {
    const viewToken = state.view,
      hash = location.hash,
      userId = state.user?.id;
    openDialog(
      "Изменить пароль",
      `<p class="muted">Подтвердите текущий пароль и задайте новый.</p>${passwordField("Текущий пароль", "current_password", true)}${state.config.password_recovery_available !== false ? '<a class="text-link" href="#forgot-password">Не помню текущий пароль</a>' : ""}${passwordField("Новый пароль", "new_password")}${passwordHelp}${passwordField("Повторите новый пароль", "repeat_password")}`,
      async (data, form) => {
        if (data.get("new_password") !== data.get("repeat_password"))
          throw Error("Пароли не совпадают.");
        await writeForForm(form, viewToken, hash, "/auth/change-password", {
          current_password: data.get("current_password"),
          password: data.get("new_password"),
        });
        if (
          !currentForm(form, viewToken, hash) ||
          state.user?.id !== userId ||
          !dialog.open
        )
          return;
        form.reset();
        dialog.close();
        toast("Пароль изменён. Можно входить с новым паролем или по коду.");
      },
      "Сохранить пароль",
    );
    dialog.classList.add("account-dialog");
    dialog.addEventListener(
      "close",
      () => dialog.classList.remove("account-dialog"),
      { once: true },
    );
  }
  async function renderProfile(set) {
    const [profile, questionnaire, training] = await Promise.all([
      api("/me"),
      api("/questionnaire"),
      api("/courses/summary"),
    ]);
    if (!set.current()) return;
    const user = profile.user,
      q = questionnaire.questionnaire || {},
      names = user.full_name.trim().split(/\s+/),
      submitted = Boolean(questionnaire.completed_at);
    state.user = user;
    const times = list(questionnaire.options?.weekdays)
      .filter((day) => number(q.availability?.[day.value]) > 0)
      .map((day) => `${day.label} — ${q.availability[day.value]} ч.`)
      .join("; ");
    const summary = (label, value) =>
      `<div class="profile-answer"><span class="muted small">${label}</span><p>${h(value || "Пока не указано")}</p></div>`;
    if (
      !set(
        `${header("Мой профиль", "Расскажите, что вам близко. Так мы сможем предложить подходящие возможности.")}<div class="profile-layout"><article class="card profile-editor"><h2>О вас</h2><form id="profile-form"><div class="form-grid">${field("Имя", "first_name", names[0], "text", true, 'autocomplete="given-name" minlength="2" maxlength="60"')}${field("Фамилия", "last_name", names.slice(1).join(" "), "text", false, 'autocomplete="family-name" maxlength="59"')}${field("Почта", "profile_email", user.email, "email", false, 'readonly autocomplete="email"')}${field("Телефон", "phone", user.phone, "tel", false, 'autocomplete="tel" maxlength="40"')}${field("Город", "city", user.city, "text", false, 'autocomplete="address-level2" maxlength="120"')}</div><div class="form-error" role="alert"></div><div class="form-actions"><button type="submit" class="button">Сохранить контакты</button><button type="reset" class="button secondary">Отменить</button></div><p class="profile-save-status small" role="status"></p></form><section class="profile-section"><div class="section-heading"><h2>Моя анкета</h2><span class="pill ${submitted ? "accepted" : ""}">${submitted ? "Отправлена" : questionnaire.updated_at ? "Черновик" : "Не заполнена"}</span></div><p class="muted">Интересы, навыки и удобный формат помогают подобрать подходящее дело.</p>${summary("Интересы", list(q.hobbies).join(" · "))}${summary("Навыки и направления", [...list(q.skills).map((s) => s.name), ...list(q.help_directions)].join(" · "))}${summary("Формат и доступность", [user.participation_format, times].filter(Boolean).join(" · "))}<a class="button" href="#questionnaire-edit">Редактировать анкету</a></section></article><aside class="profile-sidebar"><article class="card profile-identity"><span class="avatar">${h(initials(user.full_name))}</span><h2>${h(user.full_name)}</h2><p class="muted">${h(roleLabels[user.role])} «Детей Марии»</p><span class="pill">${submitted ? "Анкета отправлена" : "Анкета ждёт ваших ответов"}</span><ul class="profile-milestones"><li>${submitted ? icon("check") : ""}${submitted ? "Команда фонда познакомится с анкетой" : "Расскажите о себе в анкете"}</li><li>${number(training.summary?.required_total) === 0 ? "Обязательное обучение пока не назначено" : number(training.summary?.required_completed) >= number(training.summary?.required_total) ? "Вводные материалы пройдены" : "Знакомство с фондом впереди"}</li><li><a href="#opportunities">Можно выбирать возможности →</a></li></ul></article>${PortalAchievements.slot()}<article class="card profile-security"><h2>Вход и безопасность</h2><p class="muted">${h(user.email)}</p><span class="pill ${user.email_verified_at && !demoEmailAccount(user) ? "accepted" : ""}">${demoEmailAccount(user) ? "Тестовый аккаунт · почта не проверяется" : user.email_verified_at ? "Почта подтверждена" : "Почта не подтверждена"}</span><hr><p>${user.has_password === false ? "Пароль ещё не установлен" : "Пароль — запасной способ входа"}</p><p class="muted small">${demoEmailAccount(user) ? "Для этого тестового аккаунта доступны пароль и код 1234." : user.has_password === false ? "Вход доступен по коду из письма. Запасной пароль можно установить по ссылке на вашу почту." : "Можно входить с паролем или кодом из письма."}</p>${user.has_password === false ? "" : '<button type="button" class="button secondary" data-action="change-password">Изменить пароль</button>'}${!demoEmailAccount(user) ? `<p><a class="text-link" href="#forgot-password">${user.has_password === false ? "Установить пароль по почте" : "Восстановить пароль по почте"}</a></p>` : ""}</article><article class="card"><img src="/assets/figma/5e644.svg" alt="" width="24" height="24"><h3>Подбор становится точнее</h3><p class="muted small">Укажите интересы и навыки. Координатор учтёт их при подборе дела.</p><a class="button secondary" href="#questionnaire-edit">Открыть анкету</a></article><article class="card"><h3>Как мы держим связь</h3><p class="muted small">Ответы координатора, напоминания и изменения встреч собраны в уведомлениях.</p><a class="text-link" href="#notifications">Перейти к уведомлениям →</a></article></aside></div>`,
      )
    )
      return;
    PortalAchievements.mount({
      element: document.querySelector("[data-achievements]"),
      api,
    });
    const form = document.querySelector("#profile-form");
    let dirty = false,
      revision = 0;
    form.addEventListener("input", () => {
      dirty = true;
      revision++;
    });
    form.addEventListener("reset", () => {
      dirty = false;
      revision++;
    });
    PortalUI.setGuard(() => form.isConnected && dirty);
    bindForm(form, async (data) => {
      const submittedRevision = revision;
      const phone = String(data.get("phone")).trim();
      if (phone && !/^\+?[\d\s()\-]{7,40}$/.test(phone))
        throw Error("Проверьте номер телефона.");
      const response = await write(
        "/me",
        {
          full_name: [
            data.get("first_name").trim(),
            data.get("last_name").trim(),
          ]
            .filter(Boolean)
            .join(" "),
          phone: phone.replace(/[\s()\-]/g, ""),
          city: String(data.get("city") || "").trim(),
          birth_date: dateOnly(user.birth_date) || null,
          gender: user.gender || "unspecified",
          interests: list(user.interests),
          skills: list(user.skills),
          experience: user.experience,
          participation_format: user.participation_format,
          participation_frequency: user.participation_frequency,
        },
        "PATCH",
      ).catch((error) => {
        if (
          set.current() &&
          form.isConnected &&
          String(state.user?.id) === String(user.id)
        )
          throw error;
        return null;
      });
      if (
        !set.current() ||
        !form.isConnected ||
        String(state.user?.id) !== String(user.id)
      )
        return;
      state.user = response.user;
      dirty = submittedRevision !== revision;
      form.querySelector(".profile-save-status").textContent = dirty
        ? "Отправленные контакты сохранены. Более поздние изменения ещё не сохранены."
        : "Контакты сохранены";
      ["first_name", "last_name", "phone"].forEach((name) => {
        form.elements[name].defaultValue = String(data.get(name) || "");
      });
    });
  }
  return {
    renderLogin,
    renderRegistration,
    renderRecovery,
    changePassword,
    passwordField,
    renderProfile,
  };
})();
