import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isIP } from "node:net";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "local" },
    domain: { type: "string" },
    output: { type: "string", default: ".env" },
  },
});

if (!["local", "server", "production"].includes(values.mode)) {
  throw new Error("--mode должен быть local, server или production");
}
if (
  (values.mode === "production" || values.domain !== undefined) &&
  !isIP(values.domain || "") &&
  !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    values.domain || "",
  )
) {
  throw new Error(
    "Укажите публичный домен или IP: --domain volunteers.example.org (без https:// и пути)",
  );
}

const publicHost =
  isIP(values.domain || "") === 6
    ? `[${values.domain}]`
    : values.domain || "localhost";
const content = [
  "# Generated configuration. Keep this file private and out of Git.",
  `DOMAIN=${publicHost}`,
  `PUBLIC_ORIGIN=${values.mode === "local" ? "http://localhost:3000" : `https://${publicHost}`}`,
  `CADDY_CONFIG=${isIP(values.domain || "") ? "./deploy/Caddyfile.ip" : "./deploy/Caddyfile"}`,
  "FRONTEND_ORIGINS=",
  "POSTGRES_DB=volunteer_portal",
  "POSTGRES_USER=portal",
  `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}`,
  `SESSION_SECRET=${randomBytes(48).toString("hex")}`,
  `REGISTRATION_ENABLED=${values.mode === "local"}`,
  "EMAIL_CODE_MODE=random",
  "EMAIL_DEMO_ACCOUNTS=",
  "MAIL_TRANSPORT=smtp",
  "UNISENDER_GO_API_KEY=",
  "UNISENDER_GO_FROM_EMAIL=",
  "UNISENDER_GO_FROM_NAME=Дети Марии",
  "UNISENDER_GO_BASE_URL=https://goapi.unisender.ru/ru/transactional/api/v1",
  "PRIVACY_URL=",
  "RULES_URL=",
  "CONSENT_VERSION=1",
  "SMTP_HOST=",
  "SMTP_PORT=587",
  "SMTP_SECURE=false",
  "SMTP_USER=",
  "SMTP_PASSWORD=",
  "SMTP_FROM=",
  "",
].join("\n");

try {
  await writeFile(values.output, content, { flag: "wx", mode: 0o600 });
  console.log(
    `Создан ${values.output}. Секреты записаны в файл и не показаны в терминале.`,
  );
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(
      `${values.output} уже существует. Файл не изменён; при необходимости отредактируйте его вручную.`,
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
