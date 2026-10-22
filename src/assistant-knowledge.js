// Reviewed site facts only. User messages and model output never become facts.
const EVERYONE = ["guest", "volunteer", "coordinator", "manager", "admin"];
const SIGNED_IN = EVERYONE.filter((role) => role !== "guest");
const STAFF = ["coordinator", "manager", "admin"];
const ORGANIZERS = ["manager", "admin"];

const ROUTES = [
  {
    id: "home",
    label: "О фонде",
    href: "#home",
    roles: EVERYONE,
    terms: ["главн", "о фонде", "об организации", "домашн"],
  },
  {
    id: "opportunities",
    label: "Возможности",
    href: "#opportunities",
    roles: ["guest", "volunteer"],
    terms: ["мероприят", "событи", "возможност", "встреч", "отклик", "заявк"],
  },
  {
    id: "organizer-events",
    label: "Мероприятия",
    href: "#organizer-events",
    roles: STAFF,
    terms: ["мероприят", "событи", "возможност", "встреч", "отклик", "заявк"],
  },
  {
    id: "login",
    label: "Войти",
    href: "#login",
    roles: ["guest"],
    terms: ["вход", "войти", "авторизац", "парол", "код вход"],
  },
  {
    id: "register",
    label: "Регистрация",
    href: "#register",
    roles: ["guest"],
    terms: ["регистрац", "зарегистр", "создать аккаунт"],
  },
  {
    id: "dashboard",
    label: "Мой кабинет",
    href: "#dashboard",
    roles: ["volunteer"],
    terms: ["кабинет", "моя страниц", "мой кабинет"],
  },
  {
    id: "profile",
    label: "Мой профиль",
    href: "#profile",
    roles: SIGNED_IN,
    terms: ["профил", "контактные данные", "парол", "телефон"],
  },
  {
    id: "questionnaire",
    label: "Моя анкета",
    href: "#questionnaire",
    roles: SIGNED_IN,
    terms: ["анкет", "интерес", "навык", "опыт", "удобное время"],
  },
  {
    id: "training",
    label: "Обучение",
    href: "#training",
    roles: SIGNED_IN,
    terms: ["обучен", "курс", "урок", "учебн", "материал", "тест"],
  },
  {
    id: "participation",
    label: "Учёт участия",
    href: "#participation",
    roles: SIGNED_IN,
    terms: [
      "мой вклад",
      "участие",
      "участия",
      "час",
      "истори",
      "подтвержденное участие",
    ],
  },
  {
    id: "notifications",
    label: "Уведомления",
    href: "#notifications",
    roles: SIGNED_IN,
    terms: ["уведомлен", "напоминан", "ответ координатора"],
  },
  {
    id: "thanks",
    label: "Благодарности",
    href: "#thanks",
    roles: SIGNED_IN,
    terms: ["благодарност", "спасибо за помощь"],
  },
  {
    id: "users",
    label: "База волонтёров",
    href: "#users",
    roles: STAFF,
    terms: [
      "база волонтер",
      "список волонтер",
      "каталог волонтер",
      "карточк",
      "пользовател",
    ],
  },
  {
    id: "staff-tasks",
    label: "Задачи команды",
    href: "#staff-tasks",
    roles: STAFF,
    terms: ["задач", "поручен"],
  },
  {
    id: "messages",
    label: "Сообщения фонда",
    href: "#messages",
    roles: ORGANIZERS,
    terms: ["общий чат", "общая переписк", "входящ", "сообщен"],
  },
  {
    id: "campaigns",
    label: "Рассылки",
    href: "#campaigns",
    roles: ORGANIZERS,
    terms: ["рассылк", "кампани"],
  },
  {
    id: "analytics",
    label: "Аналитика",
    href: "#analytics",
    roles: ORGANIZERS,
    terms: ["аналитик", "отчет", "статистик", "сводк"],
  },
  {
    id: "access",
    label: "Права доступа",
    href: "#access",
    roles: ["admin"],
    terms: ["права доступа", "назначить роль", "роли", "доступы"],
  },
  {
    id: "audit",
    label: "Журнал действий",
    href: "#audit",
    roles: ["admin"],
    terms: ["журнал действ", "аудит"],
  },
  {
    id: "kistik",
    label: "Кистик",
    href: "#kistik",
    roles: EVERYONE,
    terms: ["кистик", "помощник"],
  },
];

const normalize = (value) =>
  String(value)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const roleOf = (user) => (SIGNED_IN.includes(user?.role) ? user.role : "guest");
const eventRoute = (role) =>
  STAFF.includes(role) ? "organizer-events" : "opportunities";
const hasTerm = (text, term) => {
  const value = normalize(term);
  return ` ${text}`.includes(` ${value}`);
};
const matchingTerms = (text, terms) =>
  terms.filter((term) => hasTerm(text, term));

function allowedRoutes(context) {
  return ROUTES.filter((route) => route.roles.includes(context.role));
}

function actionFor(id, context) {
  const route = allowedRoutes(context).find((item) => item.id === id);
  if (!route) return null;
  return {
    id: route.id,
    label:
      route.id === "participation" && context.role === "volunteer"
        ? "Мой вклад"
        : route.label,
    href: route.href,
  };
}

function cardsFor(context) {
  const signed = context.role !== "guest";
  const isStaff = STAFF.includes(context.role);
  const event = eventRoute(context.role);
  const card = (id, title, text, keywords, actions) => ({
    id,
    title,
    text,
    keywords,
    actions,
  });
  const registration = context.registrationAvailable
    ? "На странице регистрации можно создать аккаунт. Почту нужно подтвердить кодом из письма в том же браузере. Затем можно заполнить анкету."
    : "Регистрация сейчас временно недоступна. Существующий аккаунт можно открыть по паролю. Чтобы обсудить участие, напишите в «Чат с фондом» на главной странице.";
  const cards = [
    card(
      "about",
      "О фонде",
      "«Дети Марии» — инклюзивное пространство для детей-сирот, выпускников детских домов, детей и взрослых с ментальными особенностями. Творчество, общение и поддержка объединяют участников и волонтёров.",
      [
        "фонд",
        "дети марии",
        "организац",
        "помогает",
        "помогаете",
        "мисси",
        "кому помог",
        "о вас",
      ],
      ["home"],
    ),
    card(
      "help",
      "Как помогают волонтёры",
      "Волонтёры помогают на творческих занятиях, сопровождают участников и поддерживают общение. Конкретные задачи и условия указаны в опубликованных мероприятиях; актуальные даты смотрите в их карточках.",
      [
        "помощ",
        "помочь",
        "занима",
        "делать",
        "без опыт",
        "рисова",
        "керамик",
        "творч",
        "направлен",
        "волонтерств",
      ],
      [event, "home"],
    ),
    card(
      "start",
      "Как начать",
      signed
        ? "Расскажите об интересах, навыках и удобном времени в своей анкете, познакомьтесь с учебными материалами и выберите возможность. Координатор поможет уточнить подходящий формат участия."
        : "Начните с описания фонда и публичных возможностей. Для своей анкеты и обучения нужен аккаунт. " +
            (context.registrationAvailable
              ? "После регистрации и подтверждения почты можно рассказать о себе в анкете."
              : "Регистрация временно недоступна; обсудить участие можно через «Чат с фондом» на главной."),
      [
        "начать",
        "первый шаг",
        "первые шаги",
        "стать волонтер",
        "хочу помогать",
        "присоедин",
        "нович",
        "как устроен",
        "с чего",
      ],
      signed
        ? ["questionnaire", "training", event]
        : [event, "home", context.registrationAvailable ? "register" : "login"],
    ),
    card(
      "events",
      "Возможности и мероприятия",
      isStaff
        ? "В разделе «Мероприятия» доступны встречи и заявки участников в пределах вашей роли. Организатор создаёт и редактирует мероприятие; координатор работает с заявками и учётом участия."
        : "Публичные возможности можно просмотреть без входа. Чтобы отправить отклик, войдите в аккаунт. Закрытые встречи по приглашению доступны приглашённым волонтёрам. Дата, формат и задачи указаны в карточке мероприятия.",
      [
        "мероприят",
        "встреч",
        "событи",
        "возможност",
        "расписан",
        "ближайш",
        "дата",
        "сегодня",
        "завтра",
        "онлайн",
        "офлайн",
        "формат",
        "подобрать",
        "подбери",
        "найти дело",
      ],
      [event],
    ),
    card(
      "contact",
      "Связаться с фондом",
      "На главной странице есть кнопка «Чат с фондом»: там можно задать вопрос команде. Гостевой диалог связан с текущим браузером. Кистик объясняет работу сайта и не отправляет сообщения сотрудникам от вашего имени.",
      [
        "связа",
        "связь",
        "написать",
        "чат",
        "сотрудник",
        "координатор",
        "обратиться",
        "обратная связь",
        "контакт фонда",
      ],
      ["home"],
    ),
    card(
      "assistant",
      "Возможности Кистика",
      "Я помогаю разобраться в фонде и разделах сайта, могу предложить доступную страницу или открыть её по прямой просьбе. Я не вижу чужие анкеты, не отправляю заявки и не изменяю профиль. Фильтры и ответы в формах вы выбираете сами.",
      [
        "кистик",
        "умеешь",
        "можешь",
        "помощник",
        "помогите",
        "привет",
        "здравств",
        "добрый день",
      ],
      [event, "home"],
    ),
  ];
  if (!signed) {
    cards.push(
      card(
        "register",
        "Регистрация",
        registration,
        [
          "регистрац",
          "зарегистр",
          "создать аккаунт",
          "новый аккаунт",
          "не могу зарегистр",
          "подтвердить почт",
        ],
        context.registrationAvailable
          ? ["register", "login"]
          : ["login", "home"],
      ),
      card(
        "login",
        "Вход в аккаунт",
        context.mailAvailable
          ? "На странице входа предусмотрены четыре цифры из письма и запасной способ — пароль. Если код не приходит, выберите «Пароль». Полученный код нужно вводить в том же браузере, где он был запрошен."
          : "В существующий аккаунт можно войти по паролю. Отправка кодов по почте сейчас недоступна. На странице входа выберите способ «Пароль».",
        [
          "вход",
          "войти",
          "аккаунт",
          "парол",
          "письмо",
          "код",
          "почт",
          "авторизац",
        ],
        ["login"],
      ),
      card(
        "account-needed",
        "Личные разделы",
        "Своя анкета, обучение, уведомления и история участия доступны после входа. Публичные мероприятия и описание фонда можно посмотреть без аккаунта.",
        [
          "анкет",
          "обучен",
          "курс",
          "урок",
          "профил",
          "кабинет",
          "участи",
          "час",
          "уведомлен",
          "благодарност",
        ],
        ["login", event],
      ),
    );
  } else {
    cards.push(
      card(
        "questionnaire",
        "Моя анкета",
        context.demoCode
          ? "В своей анкете можно рассказать об интересах, навыках, опыте и удобном времени. Черновик сохраняется отдельно. Для вашего тестового аккаунта подтверждение почты пропускается; перед отправкой анкеты необходимо согласие с документами фонда. Кистик не заполняет ответы за вас."
          : "В своей анкете можно рассказать об интересах, навыках, опыте и удобном времени. Черновик сохраняется отдельно; для отправки полной анкеты нужны подтверждённая почта и ознакомление с документами фонда. Кистик не заполняет ответы за вас.",
        [
          "анкет",
          "интерес",
          "навык",
          "опыт",
          "удобное время",
          "черновик",
          "заполн",
          "соглас",
          "подтвержденная почт",
        ],
        ["questionnaire", "profile"],
      ),
      card(
        "training",
        "Обучение",
        "В разделе «Обучение» находятся доступные материалы и курсы. В курсе можно изучать уроки и выполнять задания. Обучение помогает подготовиться к встрече, но само по себе не подтверждает заявку на мероприятие.",
        [
          "обучен",
          "курс",
          "урок",
          "учебн",
          "материал",
          "тест",
          "подготов",
          "заняти",
        ],
        ["training", event],
      ),
      card(
        "applications",
        "Отклики на мероприятия",
        "Отклик сначала ожидает решения координатора. Подтверждение участия зависит от решения команды, доступных мест и условий встречи. Срок приёма заявок указан в карточке, если он задан. Кистик не отправляет и не подтверждает отклики.",
        [
          "отклик",
          "заявк",
          "записаться",
          "подтвержден",
          "принят",
          "отклон",
          "свободные места",
          "дедлайн",
          "срок приема",
        ],
        [event, "notifications"],
      ),
      card(
        "participation",
        "Учёт участия",
        "Подтверждённые участия и часы собраны в разделе учёта участия. Их записывает и при необходимости исправляет сотрудник фонда. Если запись отсутствует или в ней ошибка, свяжитесь с координатором через чат с фондом.",
        [
          "участи",
          "час",
          "мой вклад",
          "истори",
          "добавить часы",
          "исправить часы",
        ],
        ["participation", "home"],
      ),
      card(
        "profile",
        "Профиль",
        "В профиле можно обновить контактные данные и сменить пароль. Интересы, навыки, опыт и удобное время редактируются в анкете. После смены пароля другие сеансы аккаунта завершаются.",
        [
          "профил",
          "телефон",
          "контактные данные",
          "парол",
          "город",
          "имя",
          "фамили",
          "личные данные",
        ],
        ["profile", "questionnaire"],
      ),
      card(
        "notifications",
        "Уведомления",
        "Ответы на заявки, приглашения и сообщения о связанных с вами изменениях появляются в разделе «Уведомления». Благодарности за помощь собраны в отдельном разделе.",
        [
          "уведомлен",
          "напоминан",
          "благодарност",
          "спасибо за помощь",
          "ответ координатора",
          "приглашен",
        ],
        ["notifications", "thanks"],
      ),
    );
  }
  if (signed && context.demoCode) {
    cards.push(
      card(
        "demo-login",
        "Вход в тестовый аккаунт",
        "Для вашего тестового аккаунта сохранён код входа 1234. После выхода укажите ту же почту, запросите код и введите 1234 в том же браузере. Письмо для этого аккаунта не отправляется. Также можно использовать действующий пароль; восстановление пароля по почте отключено. Для регистрации нового аккаунта требуется реальный код из письма.",
        [
          "тестовый аккаунт",
          "демо",
          "вход",
          "войти",
          "код",
          "1234",
          "письмо",
          "почт",
          "восстановить пароль",
        ],
        ["profile"],
      ),
    );
  }
  if (isStaff) {
    cards.push(
      card(
        "directory",
        "База волонтёров",
        context.role === "coordinator"
          ? "В базе волонтёров координатор видит рабочие сведения волонтёров, их заявки, обучение и историю участия. Расширенные данные и заметки руководителей доступны руководителю и администратору. Кистик не читает карточки людей."
          : "В базе волонтёров можно искать людей и открывать доступные вашей роли анкеты, заявки, обучение и историю участия. Руководителю и администратору доступны расширенные сведения. Кистик не читает карточки людей.",
        [
          "база волонтер",
          "список волонтер",
          "карточк",
          "пользовател",
          "команда",
          "люди",
        ],
        ["users"],
      ),
      card(
        "tasks",
        "Задачи команды",
        "В разделе «Задачи команды» сотрудники работают с поручениями в пределах своих прав. Кистик может открыть раздел, но не создаёт поручения и не меняет их статус.",
        ["задач", "поручен"],
        ["staff-tasks"],
      ),
    );
  }
  if (ORGANIZERS.includes(context.role)) {
    cards.push(
      card(
        "organizing",
        "Подготовка мероприятий",
        "Организатор создаёт мероприятие, задаёт вместимость, срок приёма заявок, координатора и подготовку. Можно выбрать публичную встречу или доступ по приглашению. Публикация не добавляет участников и не создаёт массовую рассылку автоматически.",
        [
          "создать мероприят",
          "создать событи",
          "организ",
          "редактировать встреч",
          "публикац",
          "опубликов",
          "вместим",
          "приглашен",
          "координатор встречи",
        ],
        ["organizer-events"],
      ),
      card(
        "inbox",
        "Общий чат фонда",
        "Общий список диалогов с фондом доступен руководителю и администратору в разделе «Сообщения». Там можно читать обращения и отвечать. Кистик не читает переписку и не отвечает за сотрудников.",
        ["общий чат", "общая переписк", "входящ", "сообщен", "диалог"],
        ["messages"],
      ),
      card(
        "campaigns",
        "Рассылки",
        "Руководитель и администратор могут подготовить рассылку внутри сайта, проверить получателей в предварительном просмотре и отдельно подтвердить отправку. Почтовый канал массовых рассылок в этом разделе недоступен. Кистик ничего не рассылает.",
        ["рассылк", "кампани", "массов", "получател"],
        ["campaigns"],
      ),
      card(
        "analytics",
        "Аналитика",
        "Руководитель и администратор видят аналитику и сводные показатели в разделе «Аналитика». Кистик не получает эти показатели: актуальные данные смотрите непосредственно в разделе.",
        ["аналитик", "отчет", "статистик", "сводк", "показател"],
        ["analytics"],
      ),
    );
  }
  if (context.role === "admin") {
    cards.push(
      card(
        "access",
        "Права доступа",
        "Назначать роли пользователей может администратор. Собственную роль изменить нельзя. Права доступа редактируются в соответствующем разделе; Кистик не изменяет роли и настройки аккаунтов.",
        ["права доступа", "назначить роль", "роли", "доступы", "администратор"],
        ["access"],
      ),
      card(
        "audit",
        "Журнал действий",
        "Журнал действий доступен администратору. Он помогает посмотреть зарегистрированные изменения в системе. Кистик не читает журнал и не выполняет административные команды.",
        ["журнал действ", "аудит"],
        ["audit"],
      ),
    );
  }
  return cards;
}

function unique(values, key) {
  return values.filter(
    (value, index) =>
      values.findIndex((other) => other[key] === value[key]) === index,
  );
}

function answerFromCards(cards, context, mode = "guide") {
  const actions = unique(
    cards.flatMap((card) =>
      card.actions.map((id) => actionFor(id, context)).filter(Boolean),
    ),
    "id",
  ).slice(0, 4);
  const sources = unique(
    cards
      .map((card) => {
        const action = card.actions
          .map((id) => actionFor(id, context))
          .find(Boolean);
        return action ? { title: card.title, href: action.href } : null;
      })
      .filter(Boolean),
    "href",
  ).slice(0, 3);
  return {
    answer: cards.map((card) => card.text).join("\n\n"),
    actions,
    sources,
    mode,
  };
}

function genericGuide(context, answer) {
  const actions = [
    eventRoute(context.role),
    context.role === "guest" ? "home" : "questionnaire",
  ]
    .map((id) => actionFor(id, context))
    .filter(Boolean);
  return {
    answer:
      answer ||
      "Я помогаю с фондом «Дети Марии» и навигацией по этому сайту. По этому вопросу у меня нет проверенной информации. Спросите, как начать участие, найти мероприятие или открыть нужный раздел.",
    actions,
    sources: [],
    mode: "guide",
  };
}

function analyzeQuestion(input, context) {
  const text = normalize(input.message);
  const available = allowedRoutes(context);
  const cards = cardsFor(context);
  // Interpretation never grants access. Route matches are filtered server-side.
  // JS \b is ASCII-only; Russian navigation verbs use a whitespace boundary.
  const navigation =
    /^(?:пожалуйста\s+)?(?:открой(?:те)?|перейди(?:те)?|перенеси(?:те)?|переведи(?:те)?|покажи(?:те)?|веди|верни(?:те)?|хочу (?:открыть|перейти)|можешь (?:открыть|перейти)|можно (?:открыть|перейти))(?:\s|$)/u.test(
      text,
    ) &&
    !/(?:^|\s)(?:не|как|почему|зачем|что|когда|кто|сколько)(?:\s|$)/u.test(
      text,
    );
  const targets = available
    .map((route) => ({ route, hits: matchingTerms(text, route.terms) }))
    .filter((item) => item.hits.length);
  const restricted = ROUTES.filter(
    (route) =>
      !route.roles.includes(context.role) &&
      matchingTerms(text, route.terms).length &&
      !targets.some((target) =>
        target.route.terms.some((term) => route.terms.includes(term)),
      ),
  );
  if (navigation && targets.length === 1) {
    const target = targets[0].route;
    if (target.id === "register" && !context.registrationAvailable) {
      return {
        response: answerFromCards(
          [cards.find((card) => card.id === "register")],
          context,
        ),
      };
    }
    return {
      response: {
        answer: `Открываю раздел «${actionFor(target.id, context).label}».`,
        actions: [actionFor(target.id, context)],
        sources: [{ title: target.label, href: target.href }],
        mode: "guide",
        navigateTo: target.href,
      },
    };
  }
  if (navigation && targets.length > 1) {
    return {
      response: {
        answer: "Подходят несколько разделов. Выберите, какой открыть.",
        actions: targets
          .slice(0, 4)
          .map(({ route }) => actionFor(route.id, context)),
        sources: [],
        mode: "guide",
      },
    };
  }
  if (restricted.length && !targets.length && navigation) {
    return {
      response: genericGuide(
        context,
        context.role === "guest"
          ? "Этот раздел требует входа и соответствующих прав. Войдите в свой аккаунт; доступ определяется назначенной вам ролью."
          : "Этот раздел недоступен вашей роли. Если доступ нужен для работы, обсудите его с администратором фонда.",
      ),
    };
  }
  const words = text.split(" ");
  // A short follow-up may refer to the preceding topic. Assistant history is
  // never treated as evidence, so forged previous answers cannot add facts.
  const followup =
    words.length <= 7 &&
    /^(?:а |и |это|там|дальше|подробнее|расскажи подробнее|как это|что дальше)/u.test(
      text,
    );
  const prior = followup
    ? [...input.history].reverse().find((item) => item.role === "user")
        ?.content || ""
    : "";
  const previous = normalize(prior).slice(0, 320);
  const currentRoute = available.find(
    (route) => route.href === input.current_route,
  );
  const ranked = cards
    .map((card, index) => {
      const hits = matchingTerms(text, card.keywords);
      const priorHits = matchingTerms(previous, card.keywords);
      const score =
        hits.reduce(
          (sum, term) => sum + (normalize(term).includes(" ") ? 4 : 2),
          0,
        ) +
        priorHits.length * 0.5 +
        (followup && currentRoute && card.actions.includes(currentRoute.id)
          ? 0.5
          : 0);
      return { card, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length)
    return {
      candidates: cards.slice(0, 20),
      catalog: true,
      guide: genericGuide(context),
      previous: previous.slice(0, 180),
      currentRoute: currentRoute?.id || "",
    };
  const candidates = ranked.slice(0, 5).map((entry) => entry.card);
  const guide = answerFromCards(candidates.slice(0, 1), context);
  return {
    candidates,
    guide,
    previous: previous.slice(0, 180),
    currentRoute: currentRoute?.id || "",
  };
}

function examplesFor(role) {
  if (role === "guest")
    return [
      "Как начать помогать?",
      "Чем занимается фонд?",
      "Открой мероприятия",
    ];
  if (role === "volunteer")
    return [
      "Открой мою анкету",
      "Как откликнуться на мероприятие?",
      "Где мои часы участия?",
    ];
  if (role === "coordinator")
    return [
      "Открой базу волонтёров",
      "Как подтвердить участие?",
      "Открой задачи команды",
    ];
  return [
    "Открой аналитику",
    "Как создать мероприятие?",
    "Как подготовить рассылку?",
  ];
}

module.exports = {
  roleOf,
  allowedRoutes,
  answerFromCards,
  genericGuide,
  analyzeQuestion,
  examplesFor,
};
