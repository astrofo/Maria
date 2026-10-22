const { z, id } = require("./validation");
const { isDemoEmailAccount } = require("./verification-code");

const options = {
  hobbies: [
    "Музыка и искусство",
    "Фото, видео и дизайн",
    "Программирование и технологии",
    "Спорт",
    "Наставничество",
    "Психология",
    "Handmade",
    "Ведение соцсетей",
  ],
  skills: [
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
  ],
  help_directions: [
    "Проведение творческих занятий",
    "Фото, медиа, контент",
    "Обучение и образование",
    "Помощь педагогу и ребятам на занятиях",
    "Профессиональная помощь детям и взрослым",
    "Интернет/офлайн-магазин",
    "Помощь в организации событий",
    "Pro bono помощь (юрист/маркетолог)",
  ],
  professional_education: [
    "Педагог",
    "Дефектолог",
    "Детский психолог",
    "Нейропсихолог",
    "Логопед",
    "Маркетолог",
    "Веб-программист",
    "Юрист",
  ],
  occupations: [
    { value: "school", label: "Учусь в школе" },
    { value: "study_and_work", label: "Учусь и работаю" },
    { value: "work", label: "Работаю" },
    { value: "college_university", label: "Учусь в колледже/вузе" },
    { value: "not_study_or_work", label: "Не учусь и не работаю" },
  ],
  volunteering_durations: [
    { value: "under_3_months", label: "Меньше 3 месяцев" },
    { value: "3_9_months", label: "От 3 до 9 месяцев" },
    { value: "about_year", label: "Около года" },
    { value: "1_3_years", label: "От 1 до 3 лет" },
    { value: "over_3_years", label: "Больше 3 лет" },
  ],
  preferred_formats: [
    { value: "online", label: "Полностью онлайн" },
    { value: "in_person", label: "Очно в городе" },
    { value: "mixed", label: "Смешанный формат" },
    { value: "depends", label: "Зависит от проекта" },
  ],
  weekdays: [
    { value: "mon", label: "Понедельник" },
    { value: "tue", label: "Вторник" },
    { value: "wed", label: "Среда" },
    { value: "thu", label: "Четверг" },
    { value: "fri", label: "Пятница" },
    { value: "sat", label: "Суббота" },
    { value: "sun", label: "Воскресенье" },
  ],
  skill_levels: [
    { value: 1, label: "Хочу попробовать" },
    { value: 2, label: "Есть небольшой опыт" },
    { value: 3, label: "Уверенно обладаю" },
    { value: 4, label: "Могу обучать других" },
  ],
};
const enumFrom = (items) =>
  z
    .enum(items.map((item) => item.value))
    .nullable()
    .default(null);
const text = (max) => z.string().trim().max(max).default("");
const tags = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .default([])
  .transform((values) => [
    ...new Map(values.map((v) => [v.toLocaleLowerCase("ru"), v])).values(),
  ]);
const answer = z.boolean().nullable().default(null);
const schema = z
  .object({
    hobbies: tags,
    skills: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            level: z.number().int().min(1).max(4),
          })
          .strict(),
      )
      .max(30)
      .default([])
      .refine(
        (skills) =>
          new Set(skills.map((s) => s.name.toLocaleLowerCase("ru"))).size ===
          skills.length,
        "Навыки не должны повторяться",
      ),
    help_directions: tags,
    occupation: enumFrom(options.occupations),
    occupation_field: text(500),
    education_institution: text(300),
    has_volunteer_experience: answer,
    experience_direction: text(1000),
    experience_liked: text(2000),
    has_organizing_experience: answer,
    volunteering_duration: enumFrom(options.volunteering_durations),
    has_professional_education: answer,
    professional_education: tags,
    preferred_format: enumFrom(options.preferred_formats),
    availability: z
      .object(
        Object.fromEntries(
          options.weekdays.map(({ value }) => [
            value,
            z.number().min(0).max(24).multipleOf(0.5).default(0),
          ]),
        ),
      )
      .strict()
      .default({}),
  })
  .strict()
  .transform((q) => {
    if (q.has_volunteer_experience === false) {
      q.experience_direction = "";
      q.experience_liked = "";
      q.has_organizing_experience = null;
      q.volunteering_duration = null;
    }
    if (q.has_professional_education === false) q.professional_education = [];
    return q;
  });

function missingFields(q) {
  const missing = [];
  for (const field of ["hobbies", "skills", "help_directions"])
    if (!q[field].length) missing.push(field);
  if (!q.occupation) missing.push("occupation");
  if (
    ["college_university", "study_and_work", "work"].includes(q.occupation) &&
    !q.occupation_field
  )
    missing.push("occupation_field");
  if (
    ["college_university", "study_and_work"].includes(q.occupation) &&
    !q.education_institution
  )
    missing.push("education_institution");
  if (q.has_volunteer_experience === null)
    missing.push("has_volunteer_experience");
  if (q.has_volunteer_experience) {
    for (const field of [
      "experience_direction",
      "experience_liked",
      "volunteering_duration",
    ])
      if (!q[field]) missing.push(field);
    if (q.has_organizing_experience === null)
      missing.push("has_organizing_experience");
  }
  if (q.has_professional_education === null)
    missing.push("has_professional_education");
  if (q.has_professional_education && !q.professional_education.length)
    missing.push("professional_education");
  if (!q.preferred_format) missing.push("preferred_format");
  if (!Object.values(q.availability).some((hours) => hours > 0))
    missing.push("availability");
  return missing;
}
function response(row) {
  const questionnaire = schema.parse(row?.payload || {});
  return {
    questionnaire,
    options,
    updated_at: row?.updated_at || null,
    completed_at: row?.completed_at || null,
    missing_fields: missingFields(questionnaire),
    submitted: Boolean(row?.completed_at),
  };
}

function registerQuestionnaireRoutes(
  app,
  { db, auth, requireRole, wrap, audit },
) {
  app.get(
    "/api/questionnaire",
    auth,
    wrap(async (req, res) => {
      const { rows } = await db.query(
        "SELECT * FROM volunteer_questionnaires WHERE user_id=$1",
        [req.user.id],
      );
      res.json(response(rows[0]));
    }),
  );
  app.patch(
    "/api/questionnaire",
    auth,
    wrap(async (req, res) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        return res.status(400).json({ error: "Ожидаются ответы анкеты" });
      const { submit, ...answers } = req.body;
      if (submit !== undefined && typeof submit !== "boolean")
        return res
          .status(400)
          .json({ error: "Некорректное действие с анкетой" });
      const data = schema.parse(answers);
      const complete = req.body.submit === true;
      const demoCode = isDemoEmailAccount(req.user.email);
      if (
        complete &&
        ((!demoCode && !req.user.email_verified_at) ||
          !req.user.privacy_accepted_at ||
          !req.user.rules_accepted_at)
      ) {
        return res.status(403).json({
          error: demoCode
            ? "Для отправки анкеты подтвердите согласие с правилами и обработкой данных."
            : "Для отправки анкеты подтвердите почту и согласие с правилами и обработкой данных.",
        });
      }
      const saved = await db.transaction(async (tx) => {
        const current = (
          await tx.query(
            "SELECT email,status,auth_version,email_verified_at,rules_accepted_at,privacy_accepted_at FROM users WHERE id=$1 FOR UPDATE",
            [req.user.id],
          )
        ).rows[0];
        if (
          !current ||
          current.status === "closed" ||
          current.auth_version !== req.session.authVersion
        )
          throw Object.assign(new Error("Сессия закончилась. Войдите снова."), {
            status: 401,
          });
        if (
          complete &&
          ((!isDemoEmailAccount(current.email) && !current.email_verified_at) ||
            !current.rules_accepted_at ||
            !current.privacy_accepted_at)
        )
          throw Object.assign(
            new Error(
              isDemoEmailAccount(current.email)
                ? "Подтвердите согласие с документами фонда."
                : "Подтвердите почту и согласие с документами фонда.",
            ),
            { status: 403 },
          );
        const { rows } = await tx.query(
          `INSERT INTO volunteer_questionnaires(user_id,payload,completed_at)
         VALUES($1,$2::jsonb,CASE WHEN $3 THEN NOW() ELSE NULL END)
         ON CONFLICT(user_id) DO UPDATE SET payload=EXCLUDED.payload,
           completed_at=CASE WHEN $3 THEN COALESCE(volunteer_questionnaires.completed_at,NOW()) ELSE volunteer_questionnaires.completed_at END,
           updated_at=NOW() RETURNING *`,
          [req.user.id, JSON.stringify(data), complete],
        );
        const format =
          options.preferred_formats.find(
            (item) => item.value === data.preferred_format,
          )?.label || null;
        const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
        const frequency =
          options.weekdays
            .map(({ value }, index) =>
              data.availability[value] > 0
                ? `${days[index]}: ${data.availability[value]} ч`
                : null,
            )
            .filter(Boolean)
            .join(", ") || null;
        const experience =
          data.has_volunteer_experience === false
            ? "Опыта волонтёрства пока нет"
            : [
                data.experience_direction,
                data.experience_liked,
                options.volunteering_durations.find(
                  (item) => item.value === data.volunteering_duration,
                )?.label,
                data.has_organizing_experience === null
                  ? null
                  : `Опыт организации: ${data.has_organizing_experience ? "да" : "нет"}`,
              ]
                .filter(Boolean)
                .join("\n") || null;
        await tx.query(
          "UPDATE users SET skills=$2,interests=$3,experience=$4,participation_format=$5,participation_frequency=$6,updated_at=NOW() WHERE id=$1",
          [
            req.user.id,
            data.skills.map((s) => s.name),
            data.help_directions,
            experience,
            format,
            frequency,
          ],
        );
        await audit(
          tx,
          req.user.id,
          complete ? "complete_questionnaire" : "save_questionnaire_draft",
          "user",
          req.user.id,
        );
        return rows[0];
      });
      res.json(response(saved));
    }),
  );
  app.get(
    "/api/users/:id/questionnaire",
    requireRole("coordinator"),
    wrap(async (req, res) => {
      const userId = id.parse(req.params.id);
      const user = await db.query("SELECT id,role FROM users WHERE id=$1", [
        userId,
      ]);
      if (!user.rows.length)
        return res.status(404).json({ error: "Пользователь не найден" });
      if (req.user.role === "coordinator" && user.rows[0].role !== "volunteer")
        return res.status(403).json({ error: "Недостаточно прав" });
      const { rows } = await db.query(
        "SELECT * FROM volunteer_questionnaires WHERE user_id=$1",
        [userId],
      );
      res.json(response(rows[0]));
    }),
  );
}
module.exports = {
  registerQuestionnaireRoutes,
  questionnaireSchema: schema,
  questionnaireOptions: options,
};
