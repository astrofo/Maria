const { hashPassword } = require("./passwords");
const V = require("./validation");

const MAX_INPUT_BYTES = 8 * 1024;
const inputSchema = V.z
  .object({
    email: V.email.refine((email) =>
      email.slice(email.lastIndexOf("@") + 1).endsWith(".test"),
    ),
    password: V.password,
    full_name: V.text(120).min(2).default("Тестовый волонтёр"),
  })
  .strict();

class TestVolunteerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateInput(input) {
  const result = inputSchema.safeParse(input);
  if (!result.success) throw new TestVolunteerError("INVALID_INPUT");
  return result.data;
}

async function readInput(stream) {
  if (stream.isTTY) throw new TestVolunteerError("STDIN_REQUIRED");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES)
      throw new TestVolunteerError("INPUT_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TestVolunteerError("INVALID_JSON");
  }
}

// The database is supplied explicitly so importing this module never connects
// to a database, reads credentials, or starts the command.
async function createTestVolunteer(input, db) {
  const data = validateInput(input);
  const hash = await hashPassword(data.password);
  return db.transaction(async (tx) => {
    const existing = await tx.query(
      "SELECT id FROM users WHERE lower(email)=$1",
      [data.email],
    );
    if (existing.rows.length) throw new TestVolunteerError("ACCOUNT_EXISTS");

    const { rows } = await tx.query(
      `INSERT INTO users(
         full_name,email,password_hash,role,status,email_verified_at,
         rules_accepted_at,privacy_accepted_at,consent_version
       ) VALUES($1,$2,$3,'volunteer','active',NULL,NULL,NULL,NULL)
       ON CONFLICT(email) DO NOTHING
       RETURNING id,email,full_name,role,status`,
      [data.full_name, data.email, hash],
    );
    if (!rows.length) throw new TestVolunteerError("ACCOUNT_EXISTS");

    await tx.query(
      `INSERT INTO audit_log(action,subject_type,subject_id)
       VALUES('operator_create_test_volunteer','user',$1)`,
      [rows[0].id],
    );
    return rows[0];
  });
}

function reportError(error) {
  const messages = {
    STDIN_REQUIRED: "Передайте JSON через стандартный ввод из закрытого файла.",
    INPUT_TOO_LARGE: "Входной JSON превышает 8 КиБ.",
    INVALID_JSON:
      "Стандартный ввод должен содержать один корректный JSON-объект.",
    INVALID_INPUT:
      "Укажите email в домене .test, password от 12 до 128 символов и необязательный full_name от 2 до 120 символов. Другие поля запрещены.",
    ACCOUNT_EXISTS:
      "Аккаунт с этим email уже существует. Изменения не выполнены.",
  };
  console.error(
    error instanceof TestVolunteerError
      ? messages[error.code]
      : "Не удалось создать тестового волонтёра. Проверьте доступ к базе и применённые миграции.",
  );
}

async function main() {
  let database;
  try {
    const input = validateInput(await readInput(process.stdin));
    require("dotenv").config();
    ({ database } = require("./db"));
    await database.ready;
    const user = await createTestVolunteer(input, database);
    console.log(JSON.stringify({ created: true, user }));
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await database.close();
      } catch {
        console.error("Не удалось корректно закрыть соединение с базой.");
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) void main();

module.exports = { createTestVolunteer };
