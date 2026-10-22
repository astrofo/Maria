const nodemailer = require("nodemailer");
const { randomUUID } = require("node:crypto");
const {
  VERIFICATION_CODE_LENGTH,
  isDemoEmailCodeMode,
} = require("./verification-code");

function createSmtpSender(env) {
  const host = (env.SMTP_HOST || "").trim();
  const from = (env.SMTP_FROM || "").trim();
  const secureSetting = env.SMTP_SECURE || "false";
  const secure = secureSetting === "true";
  const port = Number(env.SMTP_PORT || (secure ? 465 : 587));
  const user = env.SMTP_USER || "";
  const password = env.SMTP_PASSWORD || "";
  const configured = Boolean(
    host &&
      from &&
      !/[\s/]/.test(host) &&
      !/[\r\n]/.test(from) &&
      from.includes("@") &&
      ["true", "false"].includes(secureSetting) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535 &&
      Boolean(user) === Boolean(password),
  );
  if (!configured) return { available: false };

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    ...(user ? { auth: { user, pass: password } } : {}),
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    dnsTimeout: 10000,
    logger: false,
    debug: false,
    transactionLog: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    maxRecipients: 1,
  });

  return {
    available: true,
    provider: "smtp",
    async send({ email, subject, text }) {
      if (!isSingleEmail(email)) throw new Error("Email recipient is invalid");
      const result = await transport.sendMail({
        from,
        to: { address: email },
        subject,
        text,
      });
      if (!result.accepted?.length || result.rejected?.length)
        throw new Error("SMTP did not confirm message acceptance");
      return { provider: "smtp" };
    },
  };
}

const UNISENDER_BASE_URLS = new Set([
  "https://goapi.unisender.ru/ru/transactional/api/v1",
  "https://go1.unisender.ru/ru/transactional/api/v1",
  "https://go2.unisender.ru/ru/transactional/api/v1",
]);

function isSingleEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value)
  );
}

function createUnisenderSender(env) {
  const apiKey = (env.UNISENDER_GO_API_KEY || "").trim();
  const fromEmail = (env.UNISENDER_GO_FROM_EMAIL || "").trim();
  const fromName = (env.UNISENDER_GO_FROM_NAME || "Дети Марии").trim();
  const baseUrl = (
    env.UNISENDER_GO_BASE_URL ||
    "https://goapi.unisender.ru/ru/transactional/api/v1"
  )
    .trim()
    .replace(/\/$/, "");
  if (
    !apiKey ||
    /\s/.test(apiKey) ||
    !isSingleEmail(fromEmail) ||
    /[\r\n]/.test(fromName) ||
    !UNISENDER_BASE_URLS.has(baseUrl)
  )
    return { available: false };

  return {
    available: true,
    provider: "unisender_go",
    async send({ email, subject, text }) {
      if (!isSingleEmail(email)) throw new Error("Email recipient is invalid");
      let response;
      let result;
      try {
        response = await fetch(`${baseUrl}/email/send.json`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-API-KEY": apiKey,
          },
          body: JSON.stringify({
            message: {
              recipients: [{ email }],
              body: { plaintext: text },
              subject,
              from_email: fromEmail,
              from_name: fromName,
              template_engine: "none",
              idempotence_key: randomUUID(),
            },
          }),
        });
        result = await response.json();
      } catch {
        // Never expose the provider response, recipient, code or API key in logs.
        throw new Error("Mail service request failed");
      }
      const acceptedRecipient =
        result?.emails === undefined ||
        (Array.isArray(result.emails) &&
          result.emails.some(
            (accepted) =>
              typeof accepted === "string" &&
              accepted.toLowerCase() === email.toLowerCase(),
          ));
      if (
        !response.ok ||
        result?.status !== "success" ||
        typeof result.job_id !== "string" ||
        !result.job_id.trim() ||
        !acceptedRecipient ||
        (result.failed_emails && Object.keys(result.failed_emails).length)
      )
        throw new Error("Mail service did not confirm message acceptance");
      return { provider: "unisender_go", jobId: result.job_id };
    },
  };
}

function createMailer(env = process.env) {
  // Demo codes are created locally; no email transport is initialized or used.
  if (isDemoEmailCodeMode(env)) return { available: false };
  const transport = (env.MAIL_TRANSPORT || "smtp").trim();
  // Select one provider explicitly. An uncertain response must not trigger a
  // second delivery via another provider.
  const sender =
    transport === "smtp"
      ? createSmtpSender(env)
      : transport === "unisender_go"
        ? createUnisenderSender(env)
        : { available: false };
  if (!sender.available) return { available: false };
  return {
    // Configured, not a delivery check. Each operation requires provider acceptance.
    available: true,
    provider: sender.provider,
    async sendPasswordReset({ email, url }) {
      return sender.send({
        email,
        subject: "Дети Марии — восстановление пароля",
        text: [
          "Для восстановления пароля откройте ссылку:",
          "",
          url,
          "",
          "Ссылка действует 10 минут и становится недействительной после изменения пароля.",
          "Если вы не запрашивали восстановление, проигнорируйте это письмо. Никому не пересылайте ссылку.",
        ].join("\n"),
      });
    },
    async sendVerification({ email, code }) {
      return sender.send({
        email,
        subject: "Дети Марии — подтверждение регистрации",
        text: [
          `Ваш код подтверждения регистрации в волонтёрском портале «Дети Марии» (${VERIFICATION_CODE_LENGTH} цифры):`,
          "",
          code,
          "",
          "Код действует 10 минут. Введите его на странице регистрации в том же браузере, где вы заполнили форму.",
          "Никому не сообщайте код. Если вы не начинали регистрацию, просто проигнорируйте это письмо.",
        ].join("\n"),
      });
    },
    async sendLoginCode({ email, code }) {
      return sender.send({
        email,
        subject: "Дети Марии — код для входа",
        text: [
          `Ваш одноразовый код для входа в волонтёрский портал «Дети Марии» (${VERIFICATION_CODE_LENGTH} цифры):`,
          "",
          code,
          "",
          "Код действует 10 минут с момента запроса. Введите его в том же браузере, где запросили вход.",
          "Если запрашивали код повторно, используйте код последнего запроса.",
          "Никому не сообщайте код. Если вы не запрашивали вход, просто проигнорируйте это письмо.",
        ].join("\n"),
      });
    },
  };
}

module.exports = { createMailer };
