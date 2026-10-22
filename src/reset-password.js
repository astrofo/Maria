require("dotenv").config();
const { hashPassword } = require("./passwords");
const { database } = require("./db");
const V = require("./validation");
async function resetPassword(db = database) {
  const email = V.email.parse(process.env.RESET_EMAIL);
  const password = V.password.parse(process.env.RESET_PASSWORD);
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      "UPDATE users SET password_hash=$1,auth_version=auth_version+1,updated_at=NOW() WHERE email=$2 RETURNING id",
      [hash, email],
    );
    if (!rows.length) throw new Error("Account not found");
    await tx.query("DELETE FROM sessions WHERE data->>'userId'=$1", [
      String(rows[0].id),
    ]);
    await tx.query(
      "INSERT INTO audit_log(action,subject_type,subject_id) VALUES('operator_password_reset','user',$1)",
      [rows[0].id],
    );
  });
}
if (require.main === module)
  resetPassword()
    .then(() => console.log("Password reset; existing sessions revoked"))
    .catch((e) => {
      console.error(
        e.name === "ZodError"
          ? "Set valid RESET_EMAIL and RESET_PASSWORD (12–128 characters)"
          : e.message,
      );
      process.exitCode = 1;
    })
    .finally(() => database.close());
module.exports = { resetPassword };
