const { randomBytes, createHash } = require("node:crypto");
const rateLimit = require("express-rate-limit");
const V = require("./validation");
const {
  questionnaireSchema,
  questionnaireOptions: options,
} = require("./questionnaire");
const { isDemoEmailAccount } = require("./verification-code");

const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 200;
const TTL = 10 * 60000;
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const key = (value) => value.trim().toLocaleLowerCase("ru");
const aliases = new Map();
const fieldLabels = new Map();
for (const [name, labels] of Object.entries({
  full_name: ["ФИО", "Имя"],
  email: ["E-mail", "Email", "Почта"],
  phone: ["Телефон"],
  city: ["Город"],
  birth_date: ["Дата рождения"],
  gender: ["Пол"],
  skills: ["Навыки"],
  interests: ["Интересы"],
  experience: ["Опыт"],
  participation_format: ["Формат участия"],
  participation_frequency: ["Частота участия"],
  questionnaire_json: ["Ответы анкеты целиком (JSON)"],
  hobbies: ["Анкета: увлечения"],
  help_directions: ["Анкета: направления помощи"],
  skill_levels: ["Анкета: навыки и уровни (включая свои варианты)"],
  occupation: ["Анкета: занятость"],
  occupation_field: ["Анкета: сфера работы или специальность"],
  education_institution: ["Анкета: учебное заведение"],
  has_volunteer_experience: ["Анкета: есть опыт волонтёрства"],
  experience_direction: ["Анкета: направление прежнего волонтёрства"],
  experience_liked: ["Анкета: что понравилось в прежнем опыте"],
  has_organizing_experience: ["Анкета: есть опыт организации"],
  volunteering_duration: ["Анкета: длительность волонтёрского опыта"],
  has_professional_education: ["Анкета: есть профильное образование"],
  professional_education: ["Анкета: профессии и профильное образование"],
  preferred_format: ["Анкета: предпочтительный формат"],
})) {
  fieldLabels.set(name, labels[0]);
  for (const label of [name, ...labels]) aliases.set(key(label), name);
}
for (const { value, label } of options.weekdays)
  for (const header of [
    `availability_${value}`,
    `Доступность: ${label} (часов)`,
  ])
    aliases.set(key(header), `availability_${value}`);
for (const name of options.skills)
  aliases.set(key(`Навык: ${name} (уровень 1–4)`), `level:${name}`);

function validationMessage(issue) {
  const field = fieldLabels.get(issue.path[0]) || issue.path.join(".");
  const message = /[а-яё]/i.test(issue.message)
    ? issue.message
    : issue.code === "too_small"
      ? `Минимально допустимое значение или длина: ${issue.minimum}.`
      : issue.code === "too_big"
        ? `Максимально допустимое значение или длина: ${issue.maximum}.`
        : issue.code === "invalid_enum_value"
          ? "Выберите допустимое значение."
          : issue.code === "unrecognized_keys"
            ? "В анкете есть неизвестные поля."
            : "Некорректное значение или формат.";
  return field ? `${field}: ${message}` : message;
}

function parseCsv(csv) {
  if (Buffer.byteLength(csv) > MAX_BYTES)
    fail(413, "CSV не должен превышать 512 КиБ.");
  if (/[\u0000\ufffd]/.test(csv)) fail(400, "Сохраните CSV в кодировке UTF-8.");
  const source = csv.replace(/^\uFEFF/, "");
  let quoted = false,
    commas = 0,
    semicolons = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (c === "\r" || c === "\n") break;
      if (c === ",") commas++;
      if (c === ";") semicolons++;
    }
  }
  const delimiter = semicolons > commas ? ";" : ",";
  const rows = [];
  let row = [],
    field = "",
    inQuote = false,
    closed = false;
  const cell = () => {
    row.push(field);
    field = "";
    closed = false;
    if (row.length > 100) fail(400, "Слишком много столбцов CSV.");
  };
  const record = () => {
    cell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1)
      fail(400, "За один импорт можно обработать до 200 строк.");
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inQuote) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
          closed = true;
        }
      } else field += c;
    } else if (c === delimiter) cell();
    else if (c === "\r" || c === "\n") {
      record();
      if (c === "\r" && source[i + 1] === "\n") i++;
    } else if (c === '"' && !field && !closed) inQuote = true;
    else if (closed && /[ \t]/.test(c)) continue;
    else if (closed || c === '"') fail(400, "Некорректные кавычки CSV.");
    else field += c;
  }
  if (inQuote) fail(400, "В CSV не закрыта кавычка.");
  if (field || row.length || closed) record();
  if (rows.length < 2)
    fail(400, "CSV должен содержать заголовки и хотя бы одну строку.");
  return rows;
}

const list = (value) =>
  value
    ? value
        .split(/[;|]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
const answer = (value) => {
  if (!value) return null;
  const v = key(value);
  if (["да", "true", "1"].includes(v)) return true;
  if (["нет", "false", "0"].includes(v)) return false;
  throw new Error("Ответ должен быть «Да» или «Нет».");
};
const option = (value, values) => {
  if (!value) return null;
  const found = values.find(
    (item) => key(item.value) === key(value) || key(item.label) === key(value),
  );
  if (!found) throw new Error(`Неизвестный вариант: ${value.slice(0, 80)}`);
  return found.value;
};

function normalizeRow(values) {
  const birthDate = values.birth_date?.replace(
    /^(\d{2})\.(\d{2})\.(\d{4})$/,
    "$3-$2-$1",
  );
  const genders = {
    мужской: "male",
    женский: "female",
    "не указан": "unspecified",
  };
  const profile = V.profile.parse({
    full_name: values.full_name,
    phone: values.phone || null,
    city: values.city || null,
    birth_date: birthDate || null,
    gender: genders[key(values.gender || "")] || values.gender || "unspecified",
    skills: list(values.skills),
    interests: list(values.interests),
    experience: values.experience || null,
    participation_format: values.participation_format || null,
    participation_frequency: values.participation_frequency || null,
  });
  const parsedEmail = V.email.safeParse(values.email);
  if (!parsedEmail.success)
    throw new Error("Некорректный адрес электронной почты.");
  const email = parsedEmail.data;
  if (isDemoEmailAccount(email))
    throw new Error(
      "Адрес зарезервирован для тестового входа и не может импортироваться.",
    );
  let questionnaire = null;
  if (values.questionnaire_json)
    questionnaire = questionnaireSchema.parse(
      JSON.parse(values.questionnaire_json),
    );
  else {
    const q = {};
    for (const name of ["hobbies", "help_directions", "professional_education"])
      if (values[name]) q[name] = list(values[name]);
    for (const name of [
      "occupation_field",
      "education_institution",
      "experience_direction",
      "experience_liked",
    ])
      if (values[name]) q[name] = values[name];
    for (const name of [
      "has_volunteer_experience",
      "has_organizing_experience",
      "has_professional_education",
    ])
      if (values[name]) q[name] = answer(values[name]);
    for (const [name, choices] of [
      ["occupation", options.occupations],
      ["volunteering_duration", options.volunteering_durations],
      ["preferred_format", options.preferred_formats],
    ])
      if (values[name]) q[name] = option(values[name], choices);
    const skills = [];
    if (values.skill_levels)
      for (const skill of list(values.skill_levels)) {
        const match = skill.match(/^(.+):\s*([1-4])(?:\s*[—-].*)?$/);
        if (!match) throw new Error("Укажите уровень навыка от 1 до 4.");
        skills.push({ name: match[1].trim(), level: Number(match[2]) });
      }
    else
      for (const name of options.skills)
        if (values[`level:${name}`])
          skills.push({ name, level: Number(values[`level:${name}`]) });
    if (skills.length) q.skills = skills;
    for (const { value } of options.weekdays)
      if (values[`availability_${value}`]) {
        q.availability ||= {};
        q.availability[value] = Number(
          values[`availability_${value}`].replace(",", "."),
        );
      }
    if (Object.keys(q).length) questionnaire = questionnaireSchema.parse(q);
  }
  if (questionnaire) {
    profile.skills = questionnaire.skills.map((skill) => skill.name);
    profile.interests = questionnaire.help_directions;
    profile.participation_format =
      options.preferred_formats.find(
        (item) => item.value === questionnaire.preferred_format,
      )?.label || null;
    profile.participation_frequency =
      options.weekdays
        .filter(({ value }) => questionnaire.availability[value] > 0)
        .map(
          ({ value, label }) =>
            `${label}: ${questionnaire.availability[value]} ч`,
        )
        .join(", ") || null;
    profile.experience =
      questionnaire.has_volunteer_experience === false
        ? "Опыта волонтёрства пока нет"
        : [questionnaire.experience_direction, questionnaire.experience_liked]
            .filter(Boolean)
            .join("\n") || null;
  }
  return { email, profile, questionnaire };
}

function registerQuestionnaireImport(
  app,
  { db, requireRole, wrap, lockCurrentUser, audit },
) {
  const tickets = new Map();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const cleanup = () => {
    for (const [id, ticket] of tickets)
      if (ticket.expires <= Date.now()) tickets.delete(id);
  };
  const limit = rateLimit({
    windowMs: 3600000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.post(
    "/api/questionnaire-import/preview",
    requireRole("manager"),
    limit,
    wrap(async (req, res) => {
      const { csv } = V.z
        .object({ csv: V.z.string().min(1).max(MAX_BYTES) })
        .strict()
        .parse(req.body);
      const [headers, ...records] = parseCsv(csv);
      const columns = headers.map((header) => aliases.get(key(header)) || null);
      const named = columns.filter(Boolean);
      if (!named.includes("email") || !named.includes("full_name"))
        fail(400, "Нужны столбцы email/full_name или E-mail/ФИО.");
      if (new Set(named).size !== named.length)
        fail(400, "Заголовки CSV повторяют одно и то же поле.");
      const ignored = headers.filter((_header, index) => !columns[index]);
      const warnings = ignored.length
        ? [
            `Пропущены столбцы: ${ignored.join(", ").slice(0, 1000)}. Роли, статусы, согласия, подтверждение почты и история участия не импортируются.`,
          ]
        : [];
      const seen = new Set(),
        normalized = [];
      const rows = records.map((record, index) => {
        const values = Object.fromEntries(
          columns.flatMap((name, column) =>
            name
              ? [
                  [
                    name,
                    (record[column] || "")
                      .trim()
                      .replace(/^'(?=[=+\-@\t])/, ""),
                  ],
                ]
              : [],
          ),
        );
        const row = {
          row: index + 2,
          email: values.email || "",
          full_name: values.full_name || "",
          status: "invalid",
          errors: [],
          warnings: [],
        };
        try {
          if (record.length !== headers.length)
            throw new Error("Количество значений не совпадает с заголовками.");
          const data = normalizeRow(values);
          row.email = data.email;
          if (seen.has(data.email)) {
            row.status = "skipped";
            row.warnings.push("Повторный email в CSV: строка пропущена.");
          } else {
            seen.add(data.email);
            row.status = "create";
            normalized.push({ row, data });
          }
        } catch (error) {
          row.errors =
            error.name === "ZodError"
              ? error.issues.map(validationMessage)
              : [
                  error instanceof SyntaxError
                    ? "Некорректный JSON анкеты."
                    : error.message,
                ];
        }
        return row;
      });
      await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "manager");
        const found = await tx.query(
          "SELECT lower(email) AS email FROM users WHERE lower(email)=ANY($1::text[])",
          [[...seen]],
        );
        const existing = new Set(found.rows.map((row) => row.email));
        for (const item of normalized)
          if (existing.has(item.data.email)) {
            item.row.status = "skipped";
            item.row.warnings.push(
              "Аккаунт уже существует: его данные не изменятся.",
            );
          }
      });
      const summary = {
        total: rows.length,
        create: rows.filter((r) => r.status === "create").length,
        skipped: rows.filter((r) => r.status === "skipped").length,
        invalid: rows.filter((r) => r.status === "invalid").length,
      };
      cleanup();
      const session = digest(req.sessionID);
      for (const [id, ticket] of tickets)
        if (ticket.actor === String(req.user.id) && ticket.session === session)
          tickets.delete(id);
      let token = null;
      if (summary.create && !summary.invalid) {
        const data = normalized
          .filter((item) => item.row.status === "create")
          .map((item) => item.data);
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (
          tickets.size >= 20 ||
          [...tickets.values()].reduce((sum, item) => sum + item.bytes, bytes) >
            4 * 1024 * 1024
        )
          fail(429, "Слишком много подготовленных импортов. Повторите позже.");
        token = randomBytes(32).toString("hex");
        const tokenKey = digest(token);
        tickets.set(tokenKey, {
          actor: String(req.user.id),
          session,
          version: req.user.auth_version,
          expires: Date.now() + TTL,
          data,
          summary,
          bytes,
        });
        setTimeout(() => tickets.delete(tokenKey), TTL).unref();
      }
      res.json({
        summary,
        rows,
        warnings,
        can_apply: Boolean(token),
        preview_token: token,
        expires_in: 600,
      });
    }),
  );
  app.post(
    "/api/questionnaire-import/apply",
    requireRole("manager"),
    limit,
    wrap(async (req, res) => {
      const input = V.z
        .object({
          preview_token: V.z.string().regex(/^[a-f0-9]{64}$/),
          confirm: V.z.literal(true),
        })
        .strict()
        .parse(req.body);
      cleanup();
      const id = digest(input.preview_token),
        ticket = tickets.get(id);
      if (
        !ticket ||
        ticket.actor !== String(req.user.id) ||
        ticket.session !== digest(req.sessionID) ||
        ticket.version !== req.user.auth_version
      )
        fail(409, "Предпросмотр истёк. Загрузите CSV и проверьте его снова.");
      // Consume before the first await, so two requests cannot apply one approval.
      // Only reviewed normalized values are used; the apply request carries no data.
      tickets.delete(id);
      const result = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user, "manager");
        if (ticket.data.some((item) => isDemoEmailAccount(item.email)))
          fail(
            409,
            "Настройки тестовых адресов изменились. Повторите предпросмотр.",
          );
        let created = 0;
        for (const { email, profile: p, questionnaire } of ticket.data) {
          // Imported records never gain a known password, consent or proof of
          // email ownership. Real email OTP is required to claim the account.
          const { rows } = await tx.query(
            `INSERT INTO users(full_name,email,password_hash,role,status,city,phone,birth_date,gender,skills,interests,experience,participation_format,participation_frequency)
           SELECT $1,$2,$3,'volunteer','new',$4,$5,$6,$7,$8,$9,$10,$11,$12
           WHERE NOT EXISTS(SELECT 1 FROM users WHERE lower(email)=$2)
           ON CONFLICT(email) DO NOTHING RETURNING id`,
            [
              p.full_name,
              email,
              `disabled:imported:${randomBytes(32).toString("hex")}`,
              p.city,
              p.phone,
              p.birth_date,
              p.gender,
              p.skills,
              p.interests,
              p.experience,
              p.participation_format,
              p.participation_frequency,
            ],
          );
          if (!rows.length) continue;
          created++;
          if (questionnaire)
            await tx.query(
              "INSERT INTO volunteer_questionnaires(user_id,payload) VALUES($1,$2::jsonb)",
              [rows[0].id, JSON.stringify(questionnaire)],
            );
          await audit(
            tx,
            req.user.id,
            "import_questionnaire",
            "user",
            rows[0].id,
          );
        }
        return {
          created,
          skipped: ticket.summary.total - created,
          total: ticket.summary.total,
        };
      });
      res.json(result);
    }),
  );
}

module.exports = { registerQuestionnaireImport };
