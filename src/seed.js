require("dotenv").config();
const { hashPassword } = require("./passwords");
const { database } = require("./db");
const { migrate } = require("./migrate");
const { password } = require("./validation");
async function seed(db = database) {
  if (process.env.DEMO_MODE !== "true" || process.env.NODE_ENV === "production")
    throw new Error("Demo seed requires DEMO_MODE=true outside production");
  const secret = password.parse(process.env.DEMO_PASSWORD);
  await migrate(db);
  const hash = await hashPassword(secret);
  await db.transaction(async (tx) => {
    const roles = [
      ["volunteer", "Анна Волонтёрова"],
      ["coordinator", "Мария Координатор"],
      ["manager", "Елена Руководитель"],
      ["admin", "Администратор демо"],
    ];
    const people = {};
    for (const [role, name] of roles) {
      await tx.query(
        "INSERT INTO users(full_name,email,password_hash,role,status,city,interests,skills) VALUES($1,$2,$3,$4,'active','Москва',ARRAY['Творчество'],ARRAY['Керамика']) ON CONFLICT(email) DO NOTHING",
        [name, `${role}@demo.local`, hash, role],
      );
      const { rows } = await tx.query("SELECT id FROM users WHERE email=$1", [
        `${role}@demo.local`,
      ]);
      people[role] = rows[0].id;
    }
    const marker = await tx.query(
      "SELECT name FROM schema_migrations WHERE name='demo_seed_v1'",
    );
    if (marker.rows.length) return;
    await tx.query(
      "INSERT INTO opportunities(title,description,city,format,location,starts_at,ends_at,skills,interests,capacity,created_by) VALUES($1,$2,'Москва','Очно','Мастерские фонда',NOW()+INTERVAL '7 days',NOW()+INTERVAL '7 days 3 hours',ARRAY['Керамика'],ARRAY['Творчество'],12,$3) RETURNING id",
      [
        "Творческая суббота в мастерских",
        "Помогите провести занятие по керамике: подготовить материалы, поддержать участников и вместе убрать рабочее пространство.",
        people.coordinator,
      ],
    );
    await tx.query(
      "INSERT INTO opportunities(title,description,city,format,starts_at,status,created_by) VALUES('Помощь с фотографиями работ','Подготовьте фотографии изделий для каталога мастерских.','Москва','Дистанционно',NOW()+INTERVAL '10 days','open',$1)",
      [people.coordinator],
    );
    await tx.query(
      "INSERT INTO training_materials(title,description,required) VALUES('Знакомство с фондом','Ознакомьтесь с миссией фонда и обсудите с координатором правила участия. В рабочей версии координатор добавит утверждённые материалы.',true),('Бережное общение','Обсудите с координатором особенности общения и сопровождения участников мастерских.',true)",
    );
    await tx.query(
      "INSERT INTO notifications(user_id,title,body) VALUES($1,'Добро пожаловать!','Заполните профиль, посмотрите обучение и выберите первое мероприятие.')",
      [people.volunteer],
    );
    await tx.query(
      "INSERT INTO schema_migrations(name) VALUES('demo_seed_v1')",
    );
  });
}
if (require.main === module)
  seed()
    .then(() => console.log("Demo data ready"))
    .catch((e) => {
      console.error(
        e.name === "ZodError"
          ? "Set DEMO_PASSWORD: 12–128 characters"
          : e.message,
      );
      process.exitCode = 1;
    })
    .finally(() => database.close());
module.exports = { seed };
