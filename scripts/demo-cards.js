#!/usr/bin/env node
// Explicit, additive content setup. It never runs during application startup.
require("dotenv").config();
const { createHash, randomBytes } = require("node:crypto");
const { database } = require("../src/db");
const { hashPassword } = require("../src/passwords");
const { publicationIssues } = require("../src/courses");

const MARKER = "demo_cards_v1";
const DEMO_NOTE =
  "Демонстрационная карточка. Это пример для знакомства с системой, а не анонс реального мероприятия фонда.";
const CONTENT_NOTE =
  "Демонстрационный учебный материал для знакомства с порталом. Перед реальным участием уточните правила у координатора фонда.";
const uuid = (key) => {
  const h = createHash("sha1").update(`${MARKER}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const cover = (number) => `/assets/figma/event-${number}.jpg`;

function lesson(key, title, type, fields = {}) {
  const value = {
    id: uuid(key),
    title,
    type,
    minutes: type === "quiz" ? 3 : 5,
    body: "",
    media_url: "",
    image_url: "",
    image_alt: "",
    caption: "",
    quote: "",
    tips: [],
    attachment_url: "",
    attachment_label: "",
    transcript: "",
    captions_url: "",
    questions: [],
    pass_count: 1,
    attempt_limit: null,
    time_limit_minutes: null,
    ...fields,
  };
  // Keep the same content revision contract as normalizeDocument in courses.js.
  value.content_hash = createHash("sha256")
    .update(
      JSON.stringify({
        type: value.type,
        body: value.body,
        media_url: value.media_url,
        image_url: value.image_url,
        tips: value.tips,
        quote: value.quote,
        attachment_url: value.attachment_url,
        transcript: value.transcript,
        questions: value.questions,
        pass_count: value.pass_count,
        attempt_limit: value.attempt_limit,
        time_limit_minutes: value.time_limit_minutes,
      }),
    )
    .digest("hex");
  return value;
}

function question(key, prompt, correct, alternatives, explanation) {
  const options = [correct, ...alternatives].map((text, index) => ({
    id: uuid(`${key}:option:${index}`),
    text,
  }));
  return {
    id: uuid(key),
    prompt,
    options,
    correct_option_id: options[0].id,
    explanation,
  };
}

function course(key, title, description, topic, image, chapters, questions) {
  const lessons = chapters.map((chapter, index) =>
    lesson(`${key}:lesson:${index}`, chapter.title, "text", {
      body: `${CONTENT_NOTE}\n\n${chapter.body}`,
      tips: chapter.tips || [],
    }),
  );
  lessons.push(
    lesson(`${key}:quiz`, "Проверьте себя", "quiz", {
      questions,
      pass_count: questions.length,
    }),
  );
  const document = {
    title: `${title} · демо`,
    description: `${description}\n\n${CONTENT_NOTE}`,
    outcomes:
      "Освоите основные действия в портале и сможете обсудить следующий шаг с координатором.",
    topic,
    author: "Демонстрационная библиотека портала",
    cover_url:
      key === "workshop"
        ? "/assets/figma/d226a.png"
        : key === "communication"
          ? "/assets/figma/d81aa.png"
          : cover(image),
    cover_alt: `Иллюстрация к демонстрационному курсу «${title}»`,
    required: false,
    audience: "all",
    order: "sequential",
    keep_access: true,
    starts_at: null,
    ends_at: null,
    result_message:
      "Демонстрационный курс завершён. Для участия в реальных событиях согласуйте подготовку с координатором фонда.",
    lessons,
  };
  const issues = publicationIssues(document);
  if (issues.length)
    throw new Error(`Invalid demo course ${key}: ${issues.join(" ")}`);
  return { key, document };
}

function courses() {
  return [
    course(
      "start",
      "Первый шаг в волонтёрстве",
      "Профиль, анкета и первый отклик: короткий маршрут для нового участника.",
      "Начало работы",
      1,
      [
        {
          title: "Познакомьтесь с порталом",
          body: "Начните с профиля: проверьте имя и город. В анкете укажите интересы, навыки и доступное время. Эти сведения помогают координатору подобрать подходящее дело.\n\nРаздел «Возможности» содержит события и условия участия. В «Обучении» можно изучить материалы, а в истории участия — увидеть подтверждённые часы. Кистик поможет найти нужный раздел.",
          tips: [
            {
              title: "Сохраняйте честный профиль",
              body: "Указывайте те навыки и время, которыми действительно готовы поделиться. Анкету можно дополнять.",
            },
          ],
        },
        {
          title: "От отклика до встречи",
          body: "Откройте карточку события и прочитайте описание, время, место, подготовку и срок записи. Если условия подходят, отправьте отклик.\n\nСтатус «На рассмотрении» означает, что координатор ещё не принял решение. После подтверждения сверьте детали встречи. Если планы изменились, отзовите отклик и предупредите координатора через чат фонда.",
          tips: [
            {
              title: "Отклик — это заявка",
              body: "Перед поездкой убедитесь, что участие подтверждено, а адрес и время актуальны.",
            },
          ],
        },
      ],
      [
        question(
          "start:q1",
          "Что означает отклик «На рассмотрении»?",
          "Координатор ещё принимает решение об участии",
          ["Участие уже подтверждено", "Мероприятие отменено"],
          "Проверьте статус отклика и дождитесь подтверждения координатора.",
        ),
        question(
          "start:q2",
          "Что сделать, если вы больше не можете прийти?",
          "Отозвать отклик и предупредить координатора",
          ["Не предпринимать ничего", "Создать новый профиль"],
          "Так координатор сможет скорректировать состав команды.",
        ),
      ],
    ),
    course(
      "communication",
      "Бережное общение в команде",
      "Как уточнять задачи, спрашивать о помощи и уважать личные границы.",
      "Коммуникация",
      2,
      [
        {
          title: "Спросите, прежде чем помогать",
          body: "Представьтесь и уточните, как удобнее обращаться к человеку. Предлагайте конкретную помощь и давайте возможность отказаться. Не делайте выводов о потребностях человека только по внешности.\n\nГоворите спокойно и понятными словами, оставляйте время на ответ. Если задача или ситуация непонятна, обращайтесь к ответственному координатору.",
          tips: [
            {
              title: "Уточняйте ожидания",
              body: "Фраза «Вам будет удобно, если я помогу с материалами?» оставляет человеку выбор.",
            },
          ],
        },
        {
          title: "Фото, общение и границы",
          body: "Перед фотографированием или публикацией материалов согласуйте действия с координатором и соблюдайте правила согласий фонда. Не публикуйте личные сведения участников в открытом доступе.\n\nНе обещайте того, чего не можете выполнить. Рабочие вопросы решайте через согласованные каналы связи. Сложную ситуацию передайте координатору, описывая наблюдаемые факты без оценок.",
          tips: [
            {
              title: "Без самостоятельных публикаций",
              body: "Готовые фотографии и тексты сначала передайте ответственному сотруднику на согласование.",
            },
          ],
        },
      ],
      [
        question(
          "communication:q1",
          "Как предложить помощь участнику?",
          "Уточнить, нужна ли помощь и какая именно",
          [
            "Сразу сделать всё за него",
            "Попросить другого участника решить за него",
          ],
          "Человек сам выбирает удобную форму поддержки.",
        ),
        question(
          "communication:q2",
          "Что сделать перед публикацией фотографии с события?",
          "Согласовать публикацию и соблюсти правила согласий фонда",
          [
            "Опубликовать, если кадр красивый",
            "Добавить подпись и сразу отправить в соцсети",
          ],
          "Согласование помогает соблюдать личные границы и правила работы с материалами.",
        ),
      ],
    ),
    course(
      "workshop",
      "Подготовка творческой мастерской",
      "Небольшой чек-лист перед занятием, во время встречи и после неё.",
      "Творческие занятия",
      3,
      [
        {
          title: "Подготовьте пространство",
          body: "Уточните у координатора план занятия и свою роль. Проверьте, какие материалы уже готовы и что нужно разложить. Оставьте свободными проходы, разместите материалы так, чтобы ими было удобно пользоваться.\n\nДо начала встречи узнайте, к кому обращаться с организационными вопросами. Для инструментов и материалов следуйте инструкциям ответственного сотрудника.",
          tips: [
            {
              title: "Короткая сверка",
              body: "Время, место, ваша роль и нужные материалы — четыре пункта, которые удобно уточнить заранее.",
            },
          ],
        },
        {
          title: "Поддерживайте процесс и завершение",
          body: "Помогайте участникам в пределах согласованной роли и сохраняйте пространство для самостоятельности. При изменении плана уточняйте следующий шаг у ведущего занятия.\n\nПосле встречи вместе приведите рабочее место в порядок. Передайте координатору наблюдения, которые помогут подготовить следующее занятие. Подтверждённые часы участия сотрудник внесёт в портал.",
          tips: [
            {
              title: "Поделитесь наблюдением",
              body: "Опишите конкретный момент: что было удобно и что можно подготовить к следующей встрече.",
            },
          ],
        },
      ],
      [
        question(
          "workshop:q1",
          "Что уточнить перед первым занятием?",
          "Свою роль, время, место и необходимые материалы",
          ["Только название мастерской", "Только список участников"],
          "Эти сведения помогают подготовиться и вовремя включиться в работу.",
        ),
        question(
          "workshop:q2",
          "Кто фиксирует подтверждённые часы участия в портале?",
          "Уполномоченный сотрудник фонда",
          ["Каждый посетитель самостоятельно", "Кистик по любому сообщению"],
          "Историю участия ведёт сотрудник после подтверждения работы на событии.",
        ),
      ],
    ),
  ];
}

const volunteers = [
  {
    key: "anna",
    name: "Анна Соколова",
    city: "Москва",
    status: "active",
    hobbies: ["Музыка и искусство", "Handmade"],
    skills: ["Работа в команде", "Преподавание"],
    directions: [
      "Проведение творческих занятий",
      "Помощь педагогу и ребятам на занятиях",
    ],
    format: "in_person",
    formatLabel: "Очно в городе",
    hours: 4,
    experience: true,
    field: "Дизайн; вымышленный пример",
  },
  {
    key: "mikhail",
    name: "Михаил Орлов",
    city: "Москва",
    status: "active",
    hobbies: ["Фото, видео и дизайн"],
    skills: ["Дизайн и графика", "Работа с текстом"],
    directions: ["Фото, медиа, контент"],
    format: "mixed",
    formatLabel: "Смешанный формат",
    hours: 3,
    experience: true,
    field: "Фотография; вымышленный пример",
  },
  {
    key: "sofia",
    name: "София Миронова",
    city: "Казань",
    status: "new",
    hobbies: ["Ведение соцсетей", "Программирование и технологии"],
    skills: ["Соцсети", "Поиск информации"],
    directions: ["Фото, медиа, контент", "Интернет/офлайн-магазин"],
    format: "online",
    formatLabel: "Полностью онлайн",
    hours: 2,
    experience: false,
    field: "Коммуникации; вымышленный пример",
  },
  {
    key: "ilya",
    name: "Илья Лесков",
    city: "Москва",
    status: "active",
    hobbies: ["Спорт", "Наставничество"],
    skills: ["Работа в команде", "Экологичная коммуникация"],
    directions: ["Помощь в организации событий"],
    format: "in_person",
    formatLabel: "Очно в городе",
    hours: 4,
    experience: true,
    field: "Организация событий; вымышленный пример",
  },
  {
    key: "elena",
    name: "Елена Белова",
    city: "Самара",
    status: "paused",
    hobbies: ["Музыка и искусство", "Наставничество"],
    skills: ["Преподавание", "Работа с документами"],
    directions: ["Обучение и образование"],
    format: "mixed",
    formatLabel: "Смешанный формат",
    hours: 2,
    experience: true,
    field: "Образование; вымышленный пример",
  },
];

function questionnaire(person) {
  return {
    hobbies: person.hobbies,
    skills: person.skills.map((name) => ({
      name,
      level: person.experience ? 3 : 1,
    })),
    help_directions: person.directions,
    occupation: "work",
    occupation_field: person.field,
    education_institution: "",
    has_volunteer_experience: person.experience,
    experience_direction: person.experience
      ? "Демонстрационный опыт: помощь в подготовке творческих встреч."
      : "",
    experience_liked: person.experience
      ? "Демонстрационный ответ: нравится поддерживать участников и работать в команде."
      : "",
    has_organizing_experience: person.experience ? person.key === "ilya" : null,
    volunteering_duration: person.experience ? "3_9_months" : null,
    has_professional_education: false,
    professional_education: [],
    preferred_format: person.format,
    availability: {
      mon: 0,
      tue: 0,
      wed: 0,
      thu: 0,
      fri: 0,
      sat: person.hours,
      sun: 0,
    },
  };
}

function events() {
  return [
    {
      key: "workshop",
      title: "Творческая мастерская: открытки вместе",
      days: 7,
      hour: 12,
      hours: 3,
      status: "open",
      format: "Очно",
      city: "Москва",
      location: "Демо-площадка: адрес уточняется у координатора",
      capacity: 12,
      image: 1,
      course: "workshop",
      skills: ["Работа в команде", "Преподавание"],
      interests: ["Проведение творческих занятий"],
      description:
        "Поможем подготовить столы и материалы, поддержим участников творческого занятия и вместе приведём мастерскую в порядок. Подходит тем, кто хочет попробовать себя в очной команде.",
      preparation:
        "Ознакомьтесь с демонстрационным курсом о мастерской. В реальном событии координатор подтвердит адрес, задачи и правила работы с материалами.",
    },
    {
      key: "photo",
      title: "Фотографии для каталога мастерской",
      days: 10,
      hour: 18,
      hours: 2,
      status: "open",
      format: "Дистанционно",
      city: "Онлайн",
      location: "Демо-задача: материалы появятся после согласования",
      capacity: 8,
      image: 2,
      course: "communication",
      skills: ["Дизайн и графика", "Работа с текстом"],
      interests: ["Фото, медиа, контент"],
      description:
        "Пример дистанционной задачи: отобрать фотографии изделий, привести изображения к единому формату и подготовить короткие подписи. Готовые материалы передаются координатору на согласование.",
      preparation:
        "Достаточно компьютера и привычного редактора изображений. Использовать реальные фотографии и публиковать их можно только после согласования.",
    },
    {
      key: "welcome",
      title: "Знакомство с волонтёрской командой",
      days: 4,
      hour: 19,
      hours: 1,
      status: "open",
      format: "Дистанционно",
      city: "Онлайн",
      location: "Демо-встреча: ссылка будет согласована отдельно",
      capacity: 20,
      image: 3,
      course: "start",
      skills: ["Экологичная коммуникация"],
      interests: ["Обучение и образование", "Помощь в организации событий"],
      description:
        "Демонстрационный формат первой встречи: знакомство с возможностями портала, обсуждение интересов и ответы на организационные вопросы. Специальные навыки не требуются.",
      preparation:
        "Заполните черновик анкеты и подготовьте вопросы о подходящем формате участия.",
    },
    {
      key: "community",
      title: "Помогаем подготовить день открытых дверей",
      days: 14,
      hour: 11,
      hours: 4,
      status: "open",
      format: "Очно",
      city: "Москва",
      location: "Демо-площадка: место уточняется перед встречей",
      capacity: 10,
      image: 2,
      course: "start",
      skills: ["Работа в команде", "Экологичная коммуникация"],
      interests: ["Помощь в организации событий"],
      description:
        "В этом примере волонтёры готовят указатели и материалы, помогают гостям ориентироваться и поддерживают организационную команду. Координатор распределяет небольшие понятные задачи.",
      preparation:
        "Уточните свою роль и время прихода. Возьмите удобную одежду для подготовки пространства.",
    },
    {
      key: "fair",
      title: "Творческая ярмарка: команда подготовки",
      days: 21,
      hour: 12,
      hours: 4,
      status: "draft",
      format: "Очно",
      city: "Москва",
      location: "Демо-черновик: площадка пока не выбрана",
      capacity: 16,
      image: 1,
      course: "workshop",
      skills: ["Работа с документами", "Работа в команде"],
      interests: ["Интернет/офлайн-магазин", "Помощь в организации событий"],
      description:
        "Черновик демонстрационного события для организатора: сбор команды для оформления стендов, подготовки изделий и встречи гостей. Карточка видна сотрудникам и готова к дальнейшему редактированию.",
      preparation:
        "Перед публикацией реального события подтвердите дату, площадку, ответственных и список задач.",
    },
    {
      key: "past",
      title: "Встреча в мастерской: общая картина",
      days: -14,
      hour: 12,
      hours: 3,
      status: "closed",
      format: "Очно",
      city: "Москва",
      location: "Демонстрационная мастерская",
      capacity: 12,
      image: 3,
      course: "communication",
      skills: ["Работа в команде", "Преподавание"],
      interests: ["Проведение творческих занятий"],
      description:
        "Пример завершённого события для истории проекта. В демонстрационных данных два вымышленных участника помогли подготовить материалы и провести творческую встречу.",
      preparation:
        "Событие завершено. Записи участия демонстрационные и не подтверждают реальную работу волонтёров.",
    },
  ];
}

function atMoscowTime(base, days, hour) {
  const day = new Date(base.getTime() + 3 * 3600000);
  day.setUTCDate(day.getUTCDate() + days);
  day.setUTCHours(hour - 3, 0, 0, 0);
  return day;
}

async function createDemoCards(db = database, env = process.env) {
  if (env.DEMO_CARDS_APPLY !== "true")
    throw new Error(
      "Set DEMO_CARDS_APPLY=true to add clearly labelled demonstration content.",
    );
  if (env.DATABASE_MODE === "pglite")
    throw new Error("This operator script requires PostgreSQL.");
  await db.ready;
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1145918281, 20261022)");
    const marker = await tx.query(
      "SELECT applied_at FROM schema_migrations WHERE name=$1",
      [MARKER],
    );
    if (marker.rows.length)
      return {
        status: "already_applied",
        marker: MARKER,
        applied_at: marker.rows[0].applied_at,
        created: {},
      };
    const applied = await tx.query(
      "SELECT name FROM schema_migrations WHERE name=ANY($1::text[])",
      [
        [
          "004_questionnaire.sql",
          "010_background_notifications.sql",
          "022_courses.sql",
          "026_event_preparation.sql",
        ],
      ],
    );
    if (applied.rows.length !== 4)
      throw new Error(
        "Apply the existing application migrations before adding demonstration cards.",
      );
    const actor = (
      await tx.query(
        "SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1 FOR SHARE",
      )
    ).rows[0];
    if (!actor) throw new Error("An active administrator must already exist.");
    const now = new Date((await tx.query("SELECT NOW() AS now")).rows[0].now);
    const people = {},
      learning = {},
      opportunities = {};

    for (const person of volunteers) {
      const email = `demo.cards.${person.key}@example.test`;
      const secretHash = await hashPassword(
        randomBytes(32).toString("base64url"),
      );
      const created = await tx.query(
        `INSERT INTO users(full_name,email,password_hash,role,status,city,interests,skills,experience,participation_format,participation_frequency)
         VALUES($1,$2,$3,'volunteer',$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(email) DO NOTHING RETURNING id`,
        [
          `Демо · ${person.name}`,
          email,
          secretHash,
          person.status,
          person.city,
          person.directions,
          person.skills,
          "Вымышленный профиль для демонстрации портала. Не является анкетой реального человека.",
          person.formatLabel,
          `Сб: ${person.hours} ч`,
        ],
      );
      if (!created.rows.length)
        throw new Error(
          `Reserved demonstration address already exists: ${email}. No existing account was changed.`,
        );
      people[person.key] = created.rows[0].id;
      await tx.query(
        "INSERT INTO volunteer_questionnaires(user_id,payload) VALUES($1,$2::jsonb)",
        [people[person.key], JSON.stringify(questionnaire(person))],
      );
    }

    for (const item of courses()) {
      const inserted = await tx.query(
        "INSERT INTO courses(document,status,created_by) VALUES($1::jsonb,'published',$2) RETURNING id",
        [JSON.stringify(item.document), actor.id],
      );
      learning[item.key] = { id: inserted.rows[0].id, document: item.document };
    }

    for (const item of events()) {
      const starts = atMoscowTime(now, item.days, item.hour);
      const ends = new Date(starts.getTime() + item.hours * 3600000);
      const deadline = new Date(starts.getTime() - 24 * 3600000);
      const inserted = await tx.query(
        `INSERT INTO opportunities(title,description,city,format,location,starts_at,ends_at,status,skills,interests,
          capacity,visibility,cover_url,cover_alt,created_by,required_course_id,application_deadline,preparation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'public',$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          `${item.title} · демо`,
          `${DEMO_NOTE}\n\n${item.description}`,
          item.city,
          item.format,
          item.location,
          starts.toISOString(),
          ends.toISOString(),
          item.status,
          item.skills,
          item.interests,
          item.capacity,
          cover(item.image),
          `Иллюстрация демонстрационного события «${item.title}»`,
          actor.id,
          learning[item.course].id,
          deadline.toISOString(),
          item.preparation,
        ],
      );
      opportunities[item.key] = {
        id: inserted.rows[0].id,
        starts_at: starts.toISOString(),
        status: item.status,
      };
    }

    // Pending future applications do not produce automatic accepted-event reminders.
    const applications = [
      ["anna", "workshop", "pending"],
      ["mikhail", "photo", "pending"],
      ["sofia", "welcome", "pending"],
      ["ilya", "community", "withdrawn"],
      ["anna", "past", "accepted"],
      ["ilya", "past", "accepted"],
    ];
    for (const [person, event, status] of applications) {
      await tx.query(
        "INSERT INTO applications(user_id,opportunity_id,status,note) VALUES($1,$2,$3,$4)",
        [
          people[person],
          opportunities[event].id,
          status,
          "Демонстрационный отклик вымышленного участника.",
        ],
      );
    }
    for (const person of ["anna", "ilya"]) {
      await tx.query(
        `INSERT INTO participation(user_id,opportunity_id,title,participated_on,hours,note,recorded_by)
         VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'Europe/Moscow')::date,3,$5,$6)`,
        [
          people[person],
          opportunities.past.id,
          "Встреча в мастерской: общая картина · демо",
          opportunities.past.starts_at,
          "Демонстрационная запись. Не учитывает реальное участие человека в работе фонда.",
          actor.id,
        ],
      );
    }
    const enrollments = [
      ["anna", "start", 1],
      ["mikhail", "communication", 3],
      ["sofia", "start", 0],
    ];
    for (const [person, key, completed] of enrollments) {
      const item = learning[key];
      await tx.query(
        "INSERT INTO course_enrollments(course_id,user_id,last_lesson_id) VALUES($1,$2,$3)",
        [
          item.id,
          people[person],
          item.document.lessons[
            Math.min(completed, item.document.lessons.length - 1)
          ].id,
        ],
      );
      for (const chapter of item.document.lessons.slice(0, completed)) {
        await tx.query(
          `INSERT INTO course_lesson_progress(course_id,user_id,lesson_id,content_hash,completed_at)
           VALUES($1,$2,$3,$4,NOW())`,
          [item.id, people[person], chapter.id, chapter.content_hash],
        );
      }
    }
    await tx.query(
      "INSERT INTO audit_log(actor_id,action,subject_type) VALUES($1,'operator_create_demo_cards','demo_content')",
      [actor.id],
    );
    await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [MARKER]);
    return {
      status: "created",
      marker: MARKER,
      created: {
        volunteers: 5,
        questionnaire_drafts: 5,
        opportunities: 6,
        courses: 3,
        lessons: 9,
        applications: 6,
        participation: 2,
        course_enrollments: 3,
        lesson_progress: 4,
        notifications: 0,
      },
      people,
      opportunities,
      courses: Object.fromEntries(
        Object.entries(learning).map(([key, item]) => [key, item.id]),
      ),
    };
  });
}

if (require.main === module) {
  createDemoCards()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      // Do not log driver details: they can contain connection strings or SQL data.
      console.error(
        error.code
          ? `Demonstration content was not applied (${error.code}).`
          : error.message,
      );
      process.exitCode = 1;
    })
    .finally(() => database.close());
}
module.exports = { createDemoCards };
