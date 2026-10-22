// Standalone local preview: persistent demo records, no Docker or global PostgreSQL.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");

if (Number(process.versions.node.split(".")[0]) !== 24) {
  console.error("Для локальной демонстрации требуется Node.js 24.");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
process.umask(0o077);
function privatePath(filename, directory = false) {
  const stat = fs.lstatSync(filename);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error(
      "Данные демонстрации должны быть обычными файлами текущего пользователя.",
    );
  fs.chmodSync(filename, directory ? 0o700 : 0o600);
}
const privateRoot = path.join(root, ".local");
for (const folder of [privateRoot, path.join(privateRoot, "demo")]) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 });
  privatePath(folder, true);
}
const directory = path.join(privateRoot, "demo");
// PGlite's persisted directory must be opened by a single launcher at a time.
const lockFile = path.join(directory, "run.lock");
const isAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
if (fs.existsSync(lockFile)) {
  privatePath(lockFile);
  const previous = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  if (isAlive(previous.pid) || isAlive(previous.serverPid)) {
    console.error(
      "Локальная демонстрация уже запущена. Откройте её существующее окно терминала.",
    );
    process.exit(1);
  }
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), {
  flag: "wx",
  mode: 0o600,
});
process.on("exit", () => {
  if (
    fs.existsSync(lockFile) &&
    JSON.parse(fs.readFileSync(lockFile, "utf8")).pid === process.pid
  )
    fs.unlinkSync(lockFile);
});
const settingsFile = path.join(directory, "settings.json");
let settings;
if (fs.existsSync(settingsFile)) {
  privatePath(settingsFile);
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  if (
    typeof settings.password !== "string" ||
    settings.password.length < 12 ||
    typeof settings.sessionSecret !== "string" ||
    settings.sessionSecret.length < 32
  )
    throw new Error("Некорректные настройки локальной демонстрации.");
} else {
  settings = {
    password: crypto.randomBytes(15).toString("base64url"),
    sessionSecret: crypto.randomBytes(48).toString("hex"),
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings), {
    mode: 0o600,
    flag: "wx",
  });
}
const accessFile = path.join(root, ".local", "demo-access.txt");
if (fs.lstatSync(accessFile, { throwIfNoEntry: false }))
  privatePath(accessFile);
fs.writeFileSync(
  accessFile,
  [
    "Локальная демонстрация «Дети Марии»",
    "Эти учётные записи созданы только в тестовой базе этого компьютера.",
    "Волонтёр: volunteer@demo.local",
    "Координатор: coordinator@demo.local",
    "Руководитель: manager@demo.local",
    "Администратор: admin@demo.local",
    `Начальный пароль: ${settings.password}`,
    "Если пароль изменён в профиле, используйте новый пароль.",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_MODE: "pglite",
  DATABASE_PATH: path.join(directory, "database"),
  DEMO_MODE: "true",
  DEMO_PASSWORD: settings.password,
  SESSION_SECRET: settings.sessionSecret,
  SESSION_COOKIE_SECURE: "false",
  REGISTRATION_ENABLED: "true",
  EMAIL_CODE_MODE: "fixed_demo",
  EMAIL_DEMO_ACCOUNTS:
    "volunteer@demo.local,coordinator@demo.local,manager@demo.local,admin@demo.local",
  // A demo must never reuse real delivery credentials from the shell or .env.
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "",
  UNISENDER_GO_API_KEY: "",
  UNISENDER_GO_FROM_EMAIL: "",
  ASSISTANT_URL: "",
  UPLOAD_DIR: path.join(directory, "uploads"),
  HOST: "127.0.0.1",
  PORT: process.env.PORT || "3000",
  TRUST_PROXY: "0",
  PUBLIC_ORIGIN: `http://localhost:${process.env.PORT || "3000"}`,
};
for (const entry of ["src/migrate.js", "src/seed.js"]) {
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Доступы к демонстрации сохранены: ${accessFile}`);
console.log(`Локальный адрес: http://localhost:${env.PORT}`);
const server = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  env,
  stdio: "inherit",
});
fs.writeFileSync(
  lockFile,
  JSON.stringify({ pid: process.pid, serverPid: server.pid }),
  { mode: 0o600 },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.on("exit", (code) => {
  process.exitCode = code || 0;
});
