require("dotenv").config();
const { hashPassword } = require("./passwords");
const { database } = require("./db");
const { migrate } = require("./migrate");
const V = require("./validation");
async function createAdmin(db = database) {
  const email = V.email.parse(process.env.ADMIN_EMAIL);
  const password = V.password.parse(process.env.ADMIN_PASSWORD);
  const fullName = V.text(120)
    .min(2)
    .parse(process.env.ADMIN_NAME || "Администратор фонда");
  await migrate(db);
  const hash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const { rows: existing } = await tx.query(
      "SELECT id FROM users WHERE email=$1",
      [email],
    );
    if (existing.length)
      throw new Error(
        "Account exists; refusing to replace password or elevate role",
      );
    const { rows } = await tx.query(
      "INSERT INTO users(full_name,email,password_hash,role,status) VALUES($1,$2,$3,'admin','active') RETURNING id",
      [fullName, email, hash],
    );
    await tx.query(
      "INSERT INTO audit_log(actor_id,action,subject_type,subject_id) VALUES($1,'bootstrap_admin','user',$1)",
      [rows[0].id],
    );
    return rows[0];
  });
}
if (require.main === module)
  createAdmin()
    .then(() => console.log("Administrator created"))
    .catch((e) => {
      console.error(
        e.name === "ZodError"
          ? "Set valid ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters)"
          : e.message,
      );
      process.exitCode = 1;
    })
    .finally(() => database.close());
module.exports = { createAdmin };
