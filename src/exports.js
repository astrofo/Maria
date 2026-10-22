const { z } = require("zod");
const { registerStreamingExports } = require("./export-stream");

const error = (status, message) =>
  Object.assign(new Error(message), { status });
const requestSchema = z
  .object({
    format: z.enum(["backup", "json", "csv"]),
    current_password: z.string().min(1).max(256),
  })
  .strict();

// Use explicit column allowlists: future authentication columns cannot silently
// become part of a business export when the schema grows.
const TABLES = {
  users: [
    "id",
    "full_name",
    "email",
    "role",
    "city",
    "birth_date",
    "gender",
    "phone",
    "interests",
    "skills",
    "experience",
    "participation_format",
    "participation_frequency",
    "status",
    "rules_accepted_at",
    "privacy_accepted_at",
    "consent_version",
    "email_verified_at",
    "created_at",
    "updated_at",
  ],
  opportunities: [
    "id",
    "cover_url",
    "cover_alt",
    "coordinator_id",
    "required_course_id",
    "application_deadline",
    "preparation",
    "title",
    "description",
    "city",
    "format",
    "starts_at",
    "ends_at",
    "status",
    "created_by",
    "created_at",
    "skills",
    "interests",
    "location",
    "capacity",
    "visibility",
    "archived_at",
    "archived_by",
  ],
  opportunity_invitations: [
    "id",
    "opportunity_id",
    "user_id",
    "invited_by",
    "status",
    "created_at",
    "updated_at",
    "revoked_at",
  ],
  staff_tasks: [
    "id",
    "user_id",
    "assigned_to",
    "created_by",
    "title",
    "description",
    "due_at",
    "priority",
    "status",
    "completed_at",
    "version",
    "created_at",
    "updated_at",
  ],
  applications: [
    "id",
    "user_id",
    "opportunity_id",
    "status",
    "note",
    "created_at",
  ],
  participation: [
    "id",
    "user_id",
    "opportunity_id",
    "title",
    "participated_on",
    "hours",
    "note",
    "recorded_by",
    "created_at",
  ],
  training_materials: [
    "id",
    "title",
    "description",
    "url",
    "required",
    "published",
    "created_at",
  ],
  training_completions: ["user_id", "material_id", "completed_at"],
  notifications: [
    "id",
    "user_id",
    "title",
    "body",
    "read_at",
    "created_at",
    "kind",
    "target_type",
    "target_id",
    "action_label",
  ],
  chat_threads: [
    "id",
    "owner_user_id",
    "guest_name",
    "guest_email",
    "opportunity_id",
    "owner_read_id",
    "staff_read_id",
    "created_at",
    "updated_at",
  ],
  chat_messages: [
    "id",
    "thread_id",
    "sender_user_id",
    "sender_kind",
    "body",
    "created_at",
  ],
  group_threads: [
    "id",
    "opportunity_id",
    "kind",
    "user_low_id",
    "user_high_id",
    "created_at",
    "updated_at",
  ],
  group_messages: [
    "id",
    "group_id",
    "sender_user_id",
    "kind",
    "body",
    "created_at",
  ],
  group_reads: ["group_id", "user_id", "last_read_id", "updated_at"],
  message_campaigns: [
    "id",
    "created_by",
    "sent_by",
    "title",
    "body",
    "kind",
    "roles",
    "opportunity_id",
    "action_label",
    "target_type",
    "status",
    "version",
    "recipient_count",
    "delivered_count",
    "skipped_count",
    "created_at",
    "updated_at",
    "sent_at",
  ],
  campaign_recipients: ["campaign_id", "user_id", "status"],
  courses: [
    "id",
    "document",
    "status",
    "version",
    "created_by",
    "created_at",
    "updated_at",
    "archived_at",
    "archived_by",
  ],
  course_enrollments: [
    "course_id",
    "user_id",
    "last_lesson_id",
    "enrolled_at",
    "updated_at",
  ],
  course_lesson_progress: [
    "course_id",
    "user_id",
    "lesson_id",
    "content_hash",
    "completed_at",
    "position_seconds",
    "attempts",
    "attempt_started_at",
    "last_result",
    "updated_at",
  ],
  staff_notes: ["id", "user_id", "author_id", "body", "created_at"],
  thanks: ["id", "user_id", "author_id", "message", "created_at"],
  audit_log: [
    "id",
    "actor_id",
    "action",
    "subject_type",
    "subject_id",
    "created_at",
  ],
  volunteer_questionnaires: [
    "user_id",
    "payload",
    "completed_at",
    "created_at",
    "updated_at",
  ],
};
function csvCell(value) {
  let text =
    value == null
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : Array.isArray(value)
          ? value.join("; ")
          : String(value);
  // Quoting alone does not stop spreadsheet formula evaluation.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

// Keep these display labels aligned with the public questionnaire options.
// Fixed skill columns keep the CSV width bounded even when users add custom skills.
const SKILL_COLUMNS = [
  "Работа в команде",
  "Экологичная коммуникация",
  "Соцсети",
  "Преподавание",
  "Дизайн и графика",
  "Работа с текстом",
  "Аналитика",
  "Работа с ИИ",
  "Поиск информации",
  "Работа с документами",
];
const SKILL_LEVELS = {
  1: "Хочу попробовать",
  2: "Есть небольшой опыт",
  3: "Уверенно обладаю",
  4: "Могу обучать других",
};
const OCCUPATIONS = {
  school: "Учусь в школе",
  college_university: "Учусь в колледже/вузе",
  study_and_work: "Учусь и работаю",
  work: "Работаю",
  not_study_or_work: "Не учусь и не работаю",
};
const VOLUNTEERING_DURATIONS = {
  under_3_months: "Меньше 3 месяцев",
  "3_9_months": "От 3 до 9 месяцев",
  about_year: "Около года",
  "1_3_years": "От 1 до 3 лет",
  over_3_years: "Больше 3 лет",
};
const PREFERRED_FORMATS = {
  online: "Полностью онлайн",
  in_person: "Очно в городе",
  mixed: "Смешанный формат",
  depends: "Зависит от проекта",
};
const WEEKDAYS = [
  ["mon", "Понедельник"],
  ["tue", "Вторник"],
  ["wed", "Среда"],
  ["thu", "Четверг"],
  ["fri", "Пятница"],
  ["sat", "Суббота"],
  ["sun", "Воскресенье"],
];
const answerLabel = (value) =>
  value === true ? "Да" : value === false ? "Нет" : "";
const optionLabel = (labels, value) =>
  typeof value === "string"
    ? Object.hasOwn(labels, value)
      ? labels[value]
      : value
    : "";
const skillsOf = (q) =>
  Array.isArray(q.skills)
    ? q.skills.filter((skill) => skill && typeof skill.name === "string")
    : [];
const QUESTIONNAIRE_COLUMNS = [
  ["Анкета: увлечения", (q) => q.hobbies],
  [
    "Анкета: навыки и уровни (включая свои варианты)",
    (q) =>
      skillsOf(q)
        .map(
          (skill) =>
            `${skill.name}: ${skill.level} — ${SKILL_LEVELS[skill.level] || ""}`,
        )
        .join("; "),
  ],
  ...SKILL_COLUMNS.map((name) => [
    `Навык: ${name} (уровень 1–4)`,
    (q) =>
      skillsOf(q).find(
        (skill) =>
          skill.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"),
      )?.level,
  ]),
  ["Анкета: направления помощи", (q) => q.help_directions],
  ["Анкета: занятость", (q) => optionLabel(OCCUPATIONS, q.occupation)],
  ["Анкета: сфера работы или специальность", (q) => q.occupation_field],
  ["Анкета: учебное заведение", (q) => q.education_institution],
  [
    "Анкета: есть опыт волонтёрства",
    (q) => answerLabel(q.has_volunteer_experience),
  ],
  ["Анкета: направление прежнего волонтёрства", (q) => q.experience_direction],
  ["Анкета: что понравилось в прежнем опыте", (q) => q.experience_liked],
  [
    "Анкета: есть опыт организации",
    (q) => answerLabel(q.has_organizing_experience),
  ],
  [
    "Анкета: длительность волонтёрского опыта",
    (q) => optionLabel(VOLUNTEERING_DURATIONS, q.volunteering_duration),
  ],
  [
    "Анкета: есть профильное образование",
    (q) => answerLabel(q.has_professional_education),
  ],
  [
    "Анкета: профессии и профильное образование",
    (q) => q.professional_education,
  ],
  [
    "Анкета: предпочтительный формат",
    (q) => optionLabel(PREFERRED_FORMATS, q.preferred_format),
  ],
  ...WEEKDAYS.map(([key, label]) => [
    `Доступность: ${label} (часов)`,
    (q) => q.availability?.[key],
  ]),
  [
    "Доступность: всего часов в неделю",
    (q) => {
      const hours = WEEKDAYS.map(([key]) => q.availability?.[key]).filter(
        (value) => typeof value === "number" && Number.isFinite(value),
      );
      return hours.length ? hours.reduce((sum, value) => sum + value, 0) : "";
    },
  ],
];

function volunteersCsv(snapshot) {
  const tables = snapshot.tables;
  const stats = snapshot.stats || new Map();
  const questionnaires = new Map(
    (tables.volunteer_questionnaires || []).map((item) => [
      String(item.user_id),
      item,
    ]),
  );
  for (const item of tables.participation || []) {
    const id = String(item.user_id);
    const stat = stats.get(id) || { hours: 0, participations: 0, accepted: 0 };
    stat.hours += Number(item.hours);
    stat.participations += 1;
    stats.set(id, stat);
  }
  for (const item of tables.applications || []) {
    const id = String(item.user_id);
    const stat = stats.get(id) || { hours: 0, participations: 0, accepted: 0 };
    if (item.status === "accepted") stat.accepted += 1;
    stats.set(id, stat);
  }
  const rows = [
    [
      "ID",
      "ФИО",
      "E-mail",
      "Телефон",
      "Город",
      "Дата рождения",
      "Пол",
      "Статус",
      "Интересы",
      "Навыки",
      "Опыт",
      "Формат участия",
      "Частота участия",
      "Часов",
      "Записей участия",
      "Принятых откликов",
      "E-mail подтверждён",
      "Создан",
      "Обновлён",
      "Анкета заполнена",
      ...QUESTIONNAIRE_COLUMNS.map(([label]) => label),
      "Анкета обновлена",
      "Ответы анкеты целиком (JSON)",
    ],
  ];
  for (const user of tables.users) {
    const stat = stats.get(String(user.id)) || {
      hours: 0,
      participations: 0,
      accepted: 0,
    };
    const questionnaire = questionnaires.get(String(user.id));
    const payload = questionnaire?.payload;
    const q =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
    rows.push([
      user.id,
      user.full_name,
      user.email,
      user.phone,
      user.city,
      user.birth_date,
      user.gender,
      user.status,
      user.interests,
      user.skills,
      user.experience,
      user.participation_format,
      user.participation_frequency,
      stat.hours.toFixed(2),
      stat.participations,
      stat.accepted,
      user.email_verified_at,
      user.created_at,
      user.updated_at,
      questionnaire?.completed_at,
      ...QUESTIONNAIRE_COLUMNS.map(([, value]) => value(q)),
      questionnaire?.updated_at,
      questionnaire ? JSON.stringify(q) : "",
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function postgresEnvironment() {
  const env = {
    PATH: "/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin",
    PGCONNECT_TIMEOUT: "15",
  };
  for (const name of [
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGSSLMODE",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (process.env.PGSSL === "true" && !env.PGSSLMODE)
    env.PGSSLMODE = "verify-full";
  if (process.env.DATABASE_URL) {
    let url;
    try {
      url = new URL(process.env.DATABASE_URL);
    } catch {
      throw error(503, "Некорректная конфигурация PostgreSQL.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw error(503, "Некорректная конфигурация PostgreSQL.");
    env.PGHOST = url.hostname.replace(/^\[|\]$/g, "");
    if (url.port) env.PGPORT = url.port;
    if (url.username) env.PGUSER = decodeURIComponent(url.username);
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
    if (url.searchParams.has("sslmode"))
      env.PGSSLMODE = url.searchParams.get("sslmode");
  }
  return env;
}

function registerExportRoutes(app, dependencies) {
  return registerStreamingExports(app, dependencies, {
    tables: TABLES,
    volunteersCsv,
    postgresEnvironment,
    requestSchema,
  });
}

module.exports = { registerExportRoutes, csvCell, volunteersCsv };
