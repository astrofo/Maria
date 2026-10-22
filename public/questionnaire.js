"use strict";

const questionnaireFieldLabels = {
  hobbies: "Хобби",
  skills: "Навыки",
  help_directions: "Направление помощи",
  occupation: "Занятие",
  occupation_field: "Сфера учёбы или работы",
  education_institution: "ВУЗ/колледж",
  has_volunteer_experience: "Опыт волонтёрства",
  experience_direction: "Направление волонтёрства",
  experience_liked: "Что особенно понравилось",
  has_organizing_experience: "Опыт организации",
  volunteering_duration: "Время волонтёрства",
  has_professional_education: "Профессиональное образование",
  professional_education: "Профессиональное образование",
  preferred_format: "Формат участия",
  availability: "Время для волонтёрства",
};
const questionnaireWeekdays = {
  mon: "ПН",
  tue: "ВТ",
  wed: "СР",
  thu: "ЧТ",
  fri: "ПТ",
  sat: "СБ",
  sun: "ВС",
};
const questionnaireValues = (items) =>
  list(items).map((item) => [item.value, item.label]);
const questionnaireLabel = (options, key, value) =>
  list(options[key]).find((item) => String(item.value) === String(value))
    ?.label || (value == null ? "Не указано" : String(value));
const yesNoLabel = (value) =>
  value === true ? "Да" : value === false ? "Нет" : "Не указано";
const questionnaireGroups = [
  ["hobbies", "Хобби", ["hobbies"]],
  ["skills_selected", "Навыки", ["skills"]],
  ["help_directions", "Направления помощи", ["help_directions"]],
  [
    "occupation",
    "Ваше занятие",
    ["occupation", "occupation_field", "education_institution"],
  ],
  [
    "has_volunteer_experience",
    "Опыт волонтёрства",
    [
      "has_volunteer_experience",
      "experience_direction",
      "experience_liked",
      "has_organizing_experience",
      "volunteering_duration",
    ],
  ],
  [
    "professional_education_none",
    "Профессиональное образование",
    ["has_professional_education", "professional_education"],
  ],
  ["preferred_format", "Удобный формат", ["preferred_format"]],
  ["available_days", "Дни и часы", ["availability"]],
];
const questionnaireMissing = (fields) =>
  questionnaireGroups.filter(([, , names]) =>
    names.some((name) => list(fields).includes(name)),
  );
const questionnaireUnique = (items) => [
  ...new Set(
    list(items)
      .map((item) => String(item).trim())
      .filter(Boolean),
  ),
];
const questionnaireEducationNote =
  "Образования с * обозначают волонтёрство на особых условиях. При дальнейшем общении с координатором мы обсудим наши общие интересы.";
const questionnaireChoiceLabel = (name, value) => {
  if (
    name === "professional_education" &&
    ["Маркетолог", "Юрист"].includes(value)
  )
    return `${value}*`;
  if (name === "skills_selected" && value === "Экологичная коммуникация")
    return "Эко коммуникация";
  if (name === "skills_selected" && value === "Соцсети") return "Соц сети";
  if (name === "hobbies" && value === "Ведение соцсетей")
    return "Ведение соц.сетей";
  return value;
};

function questionnaireChips(
  name,
  title,
  choices,
  selected = [],
  custom = false,
  extra = "",
) {
  // Saved custom values stay visible even where adding new ones is no longer offered.
  const values = questionnaireUnique([...list(choices), ...list(selected)]);
  return `<fieldset class="questionnaire-fieldset"><legend>${h(title)}</legend>
    <div class="choice-group" data-choice-group="${name}">
      ${values.map((value) => `<label class="choice-chip"><input type="checkbox" name="${name}" value="${h(value)}" ${selected.includes(value) ? "checked" : ""}><span>${h(questionnaireChoiceLabel(name, value))}</span></label>`).join("")}${extra}
    </div>
    ${custom ? `<div class="custom-choice"><label class="visually-hidden" for="custom_${name}">Добавить своё: ${h(title)}</label><input id="custom_${name}" type="text" maxlength="80" placeholder="Свой вариант" data-custom-input="${name}"><button type="button" class="button secondary compact" data-add-choice="${name}">Добавить своё</button></div>` : ""}
  </fieldset>`;
}

function questionnaireStatus(result, readOnly = false) {
  const missing = questionnaireMissing(result.missing_fields);
  const message = result.completed_at
    ? "Анкета отправлена."
    : result.updated_at
      ? "Черновик сохранён."
      : "Анкета ещё не сохранена.";
  return `<div class="questionnaire-save-state${result.completed_at ? " is-complete" : ""}" id="questionnaire-save-state" role="status" aria-live="polite">
    <strong>${message}</strong>
    ${readOnly ? "" : `<span>${result.completed_at ? "Ответы можно изменить, если ваши интересы или свободное время изменятся." : "Можно сохранить ответы сейчас и продолжить позже."}</span>`}
    ${!result.completed_at && missing.length ? `<details><summary>Что ещё заполнить (${missing.length})</summary><ul>${missing.map((item) => `<li><button type="button" class="text-link" data-question-jump="${item[0]}">${h(item[1])}</button></li>`).join("")}</ul></details>` : ""}
  </div>`;
}

function questionnaireJourney() {
  return `<aside class="questionnaire-journey" aria-labelledby="questionnaire-intro-title">
    <p class="questionnaire-eyebrow">Первый шаг к знакомству</p>
    <div class="questionnaire-intro"><h1 id="questionnaire-intro-title">Давайте<br> знакомиться.</h1><p>Расскажите немного о себе.<br>Мы поможем найти подходящую роль<br class="questionnaire-desktop-break"> и подготовиться к первой встрече.</p></div>
    <div class="questionnaire-stages"><h2>Этапы</h2><ol>
      <li aria-current="step"><span class="questionnaire-stage-number" aria-hidden="true">01</span><div><h3>Анкета</h3><p>Интересы, навыки и удобное время</p></div></li>
      <li><span class="questionnaire-stage-number" aria-hidden="true">02</span><div><h3>Знакомство</h3><p>Команда фонда свяжется с вами</p></div></li>
      <li><span class="questionnaire-stage-number" aria-hidden="true">03</span><div><h3>Первая встреча</h3><p>Обучение и дело по душе</p></div></li>
    </ol></div><a class="questionnaire-helper" href="#kistik"><img src="/assets/figma/light-20261022/a2e2b.svg" alt="Кистик" width="80" height="80"><h3>Кистик рядом</h3><p>Помогу разобраться с вопросами. Вы сами решаете, что сохранить.</p><span>Помочь с анкетой →</span></a>
  </aside>`;
}

async function renderQuestionnaire(set, userId, editing = false) {
  if (userId && !staff()) throw new APIError("Недостаточно прав", 403);
  const result = await api(
    userId
      ? `/users/${encodeURIComponent(userId)}/questionnaire`
      : "/questionnaire",
  );
  const q = result.questionnaire || {};
  const options = result.options || {};
  if (userId) return set(questionnaireReadOnly(result, userId));
  const needsConsent =
    !state.user.rules_accepted_at || !state.user.privacy_accepted_at;
  const chosenSkills = list(q.skills).map((item) => item.name);
  const levelMap = new Map(
    list(q.skills).map((item) => [item.name, item.level]),
  );
  const boolOptions = [
    ["", "Да/нет"],
    ["true", "Да"],
    ["false", "Нет"],
  ];
  const boolValue = (value) => (value == null ? "" : String(value));
  const weekdays = list(options.weekdays);
  let educationAnswer = q.has_professional_education ?? null;
  const noEducation = `<label class="choice-chip questionnaire-none"><input type="checkbox" name="professional_education_none" ${educationAnswer === false ? "checked" : ""}><span>Нет</span></label>`;

  if (
    !set(`<div class="questionnaire-page">${questionnaireJourney()}
    <form id="questionnaire-form" class="questionnaire-form-card" aria-labelledby="questionnaire-form-title">
      <h2 id="questionnaire-form-title">${editing ? "Редактировать анкету" : "Анкета волонтёра"}</h2><p class="muted small">Расскажите, что вам близко. Можно сохранить ответы и вернуться к ним позже.</p><h3 class="questionnaire-section-title">Интересы и навыки</h3>
      ${questionnaireChips("hobbies", "Что вам интересно?", options.hobbies, list(q.hobbies), true)}
      ${questionnaireChips("skills_selected", "Какими навыками вы хотите поделиться?", options.skills, chosenSkills, true)}
      <div id="questionnaire-skill-levels" class="questionnaire-skill-levels" ${chosenSkills.length ? "" : "hidden"}></div>
      ${questionnaireChips("help_directions", "В каких направлениях вы хотите помогать?", options.help_directions, list(q.help_directions))}
      <h3 class="questionnaire-section-title">О вашем опыте</h3>
      ${select("Чем вы занимаетесь?", "occupation", [["", "Выбрать из списка"], ...questionnaireValues(options.occupations)], q.occupation || "")}
      <div id="occupation-field-wrap" ${["college_university", "study_and_work", "work"].includes(q.occupation) ? "" : "hidden"}>${field("В какой сфере вы учитесь или работаете?", "occupation_field", q.occupation_field || "", "text", false, 'maxlength="500" placeholder="Ваш ответ"')}</div>
      <div id="education-institution-wrap" ${["college_university", "study_and_work"].includes(q.occupation) ? "" : "hidden"}>${field("В каком вузе или колледже вы учитесь?", "education_institution", q.education_institution || "", "text", false, 'maxlength="300" placeholder="Ваш ответ"')}</div>
      <fieldset class="questionnaire-fieldset"><legend>У вас уже был опыт волонтёрства?</legend><div class="choice-group">${[
        ["true", "Да"],
        ["false", "Нет"],
      ]
        .map(
          ([value, label]) =>
            `<label class="choice-chip"><input type="radio" name="has_volunteer_experience" value="${value}" ${boolValue(q.has_volunteer_experience) === value ? "checked" : ""}><span>${label}</span></label>`,
        )
        .join("")}</div></fieldset>
      <div id="volunteer-experience-wrap" class="questionnaire-conditional" ${q.has_volunteer_experience === true ? "" : "hidden"}>
        ${field("Какое направление?", "experience_direction", q.experience_direction || "", "text", false, 'maxlength="1000" placeholder="Ваш ответ"')}
        ${textarea("Что вам особенно понравилось?", "experience_liked", q.experience_liked || "", false, 2000)}
        ${select("Был ли опыт организации?", "has_organizing_experience", boolOptions, boolValue(q.has_organizing_experience))}
        ${select("Как долго вы занимались волонтёрством?", "volunteering_duration", [["", "Выбрать временной диапазон"], ...questionnaireValues(options.volunteering_durations)], q.volunteering_duration || "")}
      </div>
      <div class="questionnaire-education">
        ${questionnaireChips("professional_education", "Есть ли у вас профессиональное образование?", options.professional_education, list(q.professional_education), false, noEducation)}
        <p class="questionnaire-help">${h(questionnaireEducationNote)}</p>
      </div>
      <h3 class="questionnaire-section-title">Как вам удобно</h3>
      ${select("В каком формате вы готовы участвовать?", "preferred_format", [["", "Выбрать из списка"], ...questionnaireValues(options.preferred_formats)], q.preferred_format || "")}
      <fieldset class="questionnaire-fieldset questionnaire-availability"><legend>Когда вы можете уделить время волонтёрству</legend><div class="availability-grid">
        ${weekdays
          .map((day) => {
            const hours = number(q.availability?.[day.value]);
            return `<div class="availability-day"><label class="day-toggle"><input type="checkbox" name="available_days" value="${h(day.value)}" aria-label="${h(day.label)}" ${hours > 0 ? "checked" : ""}><span>${h(questionnaireWeekdays[day.value] || day.label)}</span></label><label class="visually-hidden" for="hours_${h(day.value)}">Часов в день: ${h(day.label)}</label><input id="hours_${h(day.value)}" name="hours_${h(day.value)}" type="number" min="0.5" max="24" step="0.5" value="${hours > 0 ? hours : ""}" ${hours > 0 ? "" : "disabled"} inputmode="decimal"><span class="questionnaire-hours-unit">ч.</span></div>`;
          })
          .join("")}
      </div><p id="availability-total" class="availability-total" role="status"></p></fieldset>
      <div class="questionnaire-save">
        ${questionnaireStatus(result)}
        ${needsConsent ? `<div class="notice"><p>Для отправки анкеты ознакомьтесь с документами фонда.</p>${check(`Согласен(-на) на обработку персональных данных и принимаю <a href="${h(state.config.rules_url)}" target="_blank" rel="noopener noreferrer">правила пользования сайтом</a> и <a href="${h(state.config.privacy_url)}" target="_blank" rel="noopener noreferrer">политику конфиденциальности</a>`, "account_consent", false, false)}</div>` : ""}
        ${!state.user.email_verified_at && !demoEmailAccount() ? '<p class="notice">Для отправки анкеты нужно подтвердить почту входом по коду из письма. Черновик можно сохранить сейчас.</p>' : ""}
        <div class="form-error" role="alert"></div>
        <div class="questionnaire-actions"><button type="submit" class="button secondary" data-intent="draft">${editing ? "Сохранить изменения" : "Сохранить черновик"}</button>${editing ? '<a class="button secondary" href="#profile">Отмена</a>' : '<button type="submit" class="button" data-intent="submit">Отправить анкету</button>'}</div>
        <p class="questionnaire-save-caption">Вы сможете изменить информацию в своём профиле.</p>
        <p id="questionnaire-updated" class="questionnaire-help">${result.updated_at ? "Последнее сохранение: " + date(result.updated_at, true) : ""}</p>
      </div>
    </form>
  </div>`)
  )
    return;

  const form = document.querySelector("#questionnaire-form");
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    const save = form.querySelector('[data-intent="draft"]');
    if (editing) save.disabled = false;
  };
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener(
    "submit",
    (event) => {
      form.dataset.intent = event.submitter?.dataset.intent || "draft";
    },
    true,
  );
  PortalUI.setGuard(() => form.isConnected && dirty);
  if (editing) form.querySelector('[data-intent="draft"]').disabled = true;
  function renderSkillLevels() {
    form
      .querySelectorAll("[data-skill-level]")
      .forEach((input) =>
        levelMap.set(input.dataset.skillLevel, Number(input.value)),
      );
    const skills = [
      ...form.querySelectorAll('[name="skills_selected"]:checked'),
    ].map((input) => input.value);
    const target = form.querySelector("#questionnaire-skill-levels");
    target.hidden = !skills.length;
    target.innerHTML = skills.length
      ? `<fieldset class="questionnaire-fieldset"><legend>Как вы оцениваете свой опыт?</legend><div class="skill-level-list">${skills
          .map(
            (name, index) =>
              `<div class="skill-level-row"><label for="skill-level-${index}">${h(questionnaireChoiceLabel("skills_selected", name))}</label><select id="skill-level-${index}" data-skill-level="${h(name)}">${list(
                options.skill_levels,
              )
                .map(
                  (level) =>
                    `<option value="${h(level.value)}" ${Number(level.value) === Number(levelMap.get(name) || 1) ? "selected" : ""}>${h(level.label)}</option>`,
                )
                .join("")}</select></div>`,
          )
          .join("")}</div></fieldset>`
      : "";
  }
  function updateConditions() {
    const occupation = form.elements.occupation.value;
    form.querySelector("#occupation-field-wrap").hidden = ![
      "college_university",
      "study_and_work",
      "work",
    ].includes(occupation);
    form.querySelector("#education-institution-wrap").hidden = ![
      "college_university",
      "study_and_work",
    ].includes(occupation);
    form.querySelector("#volunteer-experience-wrap").hidden =
      form.elements.has_volunteer_experience.value !== "true";
  }
  function updateEducation(target) {
    const none = form.elements.professional_education_none;
    const choices = [
      ...form.querySelectorAll('[name="professional_education"]'),
    ];
    if (target === none && none.checked)
      choices.forEach((input) => {
        input.checked = false;
      });
    else if (target.name === "professional_education" && target.checked)
      none.checked = false;
    educationAnswer = none.checked
      ? false
      : choices.some((input) => input.checked)
        ? true
        : null;
  }
  function updateAvailability() {
    let total = 0;
    form.querySelectorAll('[name="available_days"]').forEach((input) => {
      const hours = form.querySelector(`[name="hours_${input.value}"]`);
      hours.disabled = !input.checked;
      hours.required = input.checked;

      if (input.checked) total += number(hours.value);
    });
    form.querySelector("#availability-total").textContent = total
      ? `Примерно ${total.toLocaleString("ru-RU")} ч. в неделю`
      : "Дни пока не выбраны";
  }
  function addCustom(name) {
    const input = form.querySelector(`[data-custom-input="${name}"]`);
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    const group = form.querySelector(`[data-choice-group="${name}"]`);
    const existing = [...group.querySelectorAll("input")].find(
      (item) =>
        item.value.toLocaleLowerCase("ru") === value.toLocaleLowerCase("ru"),
    );
    if (existing) existing.checked = true;
    else
      group.insertAdjacentHTML(
        "beforeend",
        `<label class="choice-chip"><input type="checkbox" name="${name}" value="${h(value)}" checked><span>${h(value)}</span></label>`,
      );
    input.value = "";
    markDirty();
    if (name === "skills_selected") renderSkillLevels();
    input.focus();
  }
  form.addEventListener("change", (event) => {
    if (event.target.name === "skills_selected") renderSkillLevels();
    if (["occupation", "has_volunteer_experience"].includes(event.target.name))
      updateConditions();
    if (
      ["professional_education", "professional_education_none"].includes(
        event.target.name,
      )
    )
      updateEducation(event.target);
    if (event.target.name === "available_days") updateAvailability();
  });
  form.addEventListener("input", (event) => {
    if (event.target.name.startsWith("hours_")) updateAvailability();
  });
  form
    .querySelectorAll("[data-add-choice]")
    .forEach((item) =>
      item.addEventListener("click", () => addCustom(item.dataset.addChoice)),
    );
  form.querySelectorAll("[data-custom-input]").forEach((input) =>
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addCustom(input.dataset.customInput);
      }
    }),
  );
  renderSkillLevels();
  updateConditions();
  updateAvailability();
  form.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-question-jump]");
    if (!jump) return;
    const target = form.querySelector(`[name="${jump.dataset.questionJump}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      PortalUI.scrollToElement(target.closest("fieldset,.field") || target);
    }
  });
  bindForm(form, async (data) => {
    const asBool = (value) =>
      value === "true" ? true : value === "false" ? false : null;
    const hasExperience = asBool(data.get("has_volunteer_experience"));
    const selectedEducation = data.getAll("professional_education");
    const hasEducation = data.has("professional_education_none")
      ? false
      : selectedEducation.length
        ? true
        : educationAnswer;
    const skillLevels = new Map(
      [...form.querySelectorAll("[data-skill-level]")].map((input) => [
        input.dataset.skillLevel,
        Number(input.value),
      ]),
    );
    const selectedDays = new Set(data.getAll("available_days"));
    const payload = {
      hobbies: data.getAll("hobbies"),
      skills: data
        .getAll("skills_selected")
        .map((name) => ({ name, level: skillLevels.get(name) || 1 })),
      help_directions: data.getAll("help_directions"),
      occupation: data.get("occupation") || null,
      // A narrower visibility rule must not erase previously saved school details.
      occupation_field: data.get("occupation_field").trim(),
      education_institution: data.get("education_institution").trim(),
      has_volunteer_experience: hasExperience,
      experience_direction:
        hasExperience === false ? "" : data.get("experience_direction").trim(),
      experience_liked:
        hasExperience === false ? "" : data.get("experience_liked").trim(),
      has_organizing_experience:
        hasExperience === false
          ? null
          : asBool(data.get("has_organizing_experience")),
      volunteering_duration:
        hasExperience === false
          ? null
          : data.get("volunteering_duration") || null,
      has_professional_education: hasEducation,
      professional_education: hasEducation === false ? [] : selectedEducation,
      preferred_format: data.get("preferred_format") || null,
      availability: Object.fromEntries(
        weekdays.map((day) => [
          day.value,
          selectedDays.has(day.value)
            ? Number(data.get(`hours_${day.value}`))
            : 0,
        ]),
      ),
    };
    for (const name of [
      "hobbies",
      "skills",
      "help_directions",
      "professional_education",
    ]) {
      if (payload[name].length > 30)
        throw Error(
          `В разделе «${questionnaireFieldLabels[name]}» можно выбрать не более 30 вариантов.`,
        );
    }
    if (form.dataset.intent === "submit" && needsConsent) {
      if (!data.has("account_consent"))
        throw Error(
          "Для отправки анкеты подтвердите согласие с документами фонда.",
        );
      const consent = await write("/me/consents", {
        rules_accepted: true,
        privacy_accepted: true,
      });
      if (!set.current() || !form.isConnected) return;
      state.user = consent.user;
    }
    const response = await write(
      "/questionnaire",
      { ...payload, submit: form.dataset.intent === "submit" },
      "PATCH",
    );
    if (!set.current() || !form.isConnected) return;
    dirty = false;
    if (editing) {
      PortalUI.clearGuard();
      navigate("profile");
      toast("Изменения анкеты сохранены");
      return;
    }
    form.querySelector("#questionnaire-save-state").outerHTML =
      questionnaireStatus(response);
    form.querySelector("#questionnaire-updated").textContent =
      "Последнее сохранение: " + date(response.updated_at, true);
    toast(
      form.dataset.intent === "submit"
        ? "Анкета отправлена"
        : "Черновик анкеты сохранён",
    );
    if (form.dataset.intent === "submit" && form.isConnected)
      navigate("questionnaire-sent");
    else if (form.isConnected)
      openDialog(
        "Черновик анкеты сохранён",
        '<p class="muted">Ответы сохранены. Вы сможете вернуться к анкете и отправить её команде фонда позже.</p><button class="button" type="button" data-action="close-dialog">Продолжить заполнение</button>',
      );
  });
}

async function renderSuccess(container) {
  // Confirm saved completion on the server even when this route is opened directly.
  const result = await api("/questionnaire");
  const set =
    typeof container === "function"
      ? container
      : (markup) => {
          if (!container?.isConnected) return false;
          container.innerHTML = markup;
          return true;
        };
  if (!result.completed_at) {
    if (set("") !== false) navigate("questionnaire");
    return;
  }
  return set(`<section class="questionnaire-success" aria-labelledby="questionnaire-success-title">
    <img class="questionnaire-kistik" src="/assets/figma/kistik-ready.svg" width="200" height="200" alt="Кистик с кистью">
    <p class="questionnaire-eyebrow">Анкета отправлена</p>
    <div class="questionnaire-success-heading"><h1 id="questionnaire-success-title">Спасибо, что вы рядом.</h1><p>Команда фонда познакомится с вашей анкетой<br>и свяжется с вами. Статус и сообщения будут в кабинете.</p></div>
    <article class="questionnaire-success-card"><h2>А пока можно познакомиться с фондом</h2><p>Посмотрите вводные материалы и узнайте,<br>как проходят встречи с участниками.</p></article>
    <div class="questionnaire-success-actions"><a class="button" href="#dashboard">В мой кабинет</a><a class="button secondary" href="#questionnaire-edit">Посмотреть анкету</a></div>
  </section>`);
}

function questionnaireReadOnly(result, userId) {
  const q = result.questionnaire || {},
    options = result.options || {};
  const valueList = (values, name = "") =>
    list(values).length
      ? `<div class="questionnaire-answer-tags">${list(values)
          .map(
            (value) =>
              `<span>${h(questionnaireChoiceLabel(name, value))}</span>`,
          )
          .join("")}</div>`
      : "Не указано";
  const entry = (label, value) =>
    `<div class="questionnaire-answer"><dt>${h(label)}</dt><dd>${value}</dd></div>`;
  const availability = list(options.weekdays)
    .filter((day) => number(q.availability?.[day.value]) > 0)
    .map((day) => `${day.label}: ${number(q.availability[day.value])} ч.`);
  return `<div class="questionnaire-page questionnaire-readonly">
    <aside class="questionnaire-journey"><a class="back-link" href="#users/${h(userId)}">← Карточка волонтёра</a><div class="questionnaire-intro"><p class="questionnaire-eyebrow">Ответы волонтёра</p><h1>Анкета</h1><p>Интересы, опыт и удобное время.</p></div>${questionnaireStatus(result, true)}</aside>
    <article class="questionnaire-form-card" aria-labelledby="questionnaire-readonly-title"><h2 id="questionnaire-readonly-title">Анкета волонтёра</h2><dl class="questionnaire-answers">
      ${entry("Что вам интересно?", valueList(q.hobbies, "hobbies"))}
      ${entry(
        "Какими навыками вы хотите поделиться?",
        valueList(
          list(q.skills).map((skill) => skill.name),
          "skills_selected",
        ),
      )}
      ${list(q.skills).length ? entry("Как вы оцениваете свой опыт?", `<ul class="questionnaire-answer-skills">${q.skills.map((skill) => `<li><strong>${h(questionnaireChoiceLabel("skills_selected", skill.name))}</strong><span>${h(questionnaireLabel(options, "skill_levels", skill.level))}</span></li>`).join("")}</ul>`) : ""}
      ${entry("В каких направлениях вы хотите помогать?", valueList(q.help_directions))}
      ${entry("Чем вы занимаетесь?", h(questionnaireLabel(options, "occupations", q.occupation)))}
      ${q.occupation_field || ["college_university", "study_and_work", "work"].includes(q.occupation) ? entry("В какой сфере вы учитесь или работаете?", h(q.occupation_field || "Не указано")) : ""}
      ${q.education_institution || ["college_university", "study_and_work"].includes(q.occupation) ? entry("В каком вузе или колледже вы учитесь?", h(q.education_institution || "Не указано")) : ""}
      ${entry("У вас уже был опыт волонтёрства?", yesNoLabel(q.has_volunteer_experience))}
      ${q.has_volunteer_experience ? `${entry("Какое направление?", h(q.experience_direction || "Не указано"))}${entry("Что вам особенно понравилось?", `<span class="preserve">${h(q.experience_liked || "Не указано")}</span>`)}${entry("Был ли опыт организации?", yesNoLabel(q.has_organizing_experience))}${entry("Как долго вы занимались волонтёрством?", h(questionnaireLabel(options, "volunteering_durations", q.volunteering_duration)))}` : ""}
      ${entry("Есть ли у вас профессиональное образование?", `${q.has_professional_education === false ? "Нет" : valueList(q.professional_education, "professional_education")}<p class="questionnaire-help">${h(questionnaireEducationNote)}</p>`)}
      ${entry("В каком формате вы готовы участвовать?", h(questionnaireLabel(options, "preferred_formats", q.preferred_format)))}
      ${entry("Когда вы можете уделить время волонтёрству", valueList(availability))}
    </dl>${result.updated_at ? `<p class="questionnaire-help">Последнее сохранение: ${date(result.updated_at, true)}</p>` : ""}</article>
  </div>`;
}
