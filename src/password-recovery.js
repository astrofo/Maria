const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const V = require("./validation");
const { hashPassword } = require("./passwords");
const {
  isDemoEmailAccount,
  emailDemoAccounts,
} = require("./verification-code");

function passwordRecoveryAvailable(mailer, env = process.env) {
  let origin;
  try {
    const value = new URL(env.PUBLIC_ORIGIN);
    if (value.protocol === "https:") origin = value.origin;
  } catch {}
  return Boolean(
    env.SESSION_SECRET &&
      origin &&
      mailer.available &&
      typeof mailer.sendPasswordReset === "function",
  );
}

function registerPasswordRecoveryRoutes(app, { db, mailer, wrap, audit }) {
  const secret = process.env.SESSION_SECRET;
  let origin;
  try {
    const value = new URL(process.env.PUBLIC_ORIGIN);
    if (value.protocol === "https:") origin = value.origin;
  } catch {}
  const available = passwordRecoveryAvailable(mailer);
  const unavailable = () => ({
    error:
      "Отправка писем для восстановления сейчас недоступна. Попробуйте позже или обратитесь к администратору.",
    code: "password_recovery_unavailable",
  });
  const digest = (value) =>
    crypto.createHmac("sha256", secret).update(value).digest("base64url");
  const neutral = {
    message:
      "Если аккаунт с такой почтой существует, мы отправим инструкции для восстановления.",
    resend_after: 30,
  };
  const limiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Слишком много запросов. Повторите через 15 минут." },
  });
  let deliveries = 0;
  app.post(
    "/api/auth/password-reset/request",
    limiter,
    wrap(async (req, res) => {
      const { email } = V.z.object({ email: V.email }).parse(req.body);
      if (isDemoEmailAccount(email))
        return res.status(403).json({
          error:
            "Восстановление пароля тестового аккаунта отключено. Войдите по коду 1234 или используйте действующий пароль.",
          code: "demo_password_recovery_disabled",
        });
      if (!available) return res.status(503).json(unavailable());
      const emailHash = digest(`reset-email:${email}`);
      const allowed = await db.transaction(async (tx) => {
        await tx.query(
          "DELETE FROM password_reset_requests WHERE requested_at < NOW() - INTERVAL '2 days'",
        );
        const result = await tx.query(
          `INSERT INTO password_reset_requests(email_hash) VALUES($1)
        ON CONFLICT(email_hash) DO UPDATE SET requested_at=NOW(),
        window_at=CASE WHEN password_reset_requests.window_at < NOW() - INTERVAL '1 hour' THEN NOW() ELSE password_reset_requests.window_at END,
        send_count=CASE WHEN password_reset_requests.window_at < NOW() - INTERVAL '1 hour' THEN 1 ELSE password_reset_requests.send_count+1 END
        WHERE password_reset_requests.requested_at < NOW() - INTERVAL '30 seconds'
        AND (password_reset_requests.send_count < 5 OR password_reset_requests.window_at < NOW() - INTERVAL '1 hour') RETURNING email_hash`,
          [emailHash],
        );
        return result.rows.length > 0;
      });
      const { rows } = await db.query(
        "SELECT id,email,auth_version FROM users WHERE email=$1 AND status<>'closed'",
        [email],
      );
      // Same public response for known/unknown accounts; no token is returned to the browser.
      res.json(neutral);
      if (!allowed || !rows.length || deliveries >= 8) return;
      const user = rows[0];
      const body = Buffer.from(
        JSON.stringify([
          String(user.id),
          Number(user.auth_version),
          Date.now() + 10 * 60000,
          crypto.randomBytes(16).toString("hex"),
        ]),
      ).toString("base64url");
      const token = `${body}.${digest(`password-reset:${body}`)}`;
      deliveries++;
      try {
        await mailer.sendPasswordReset({
          email: user.email,
          url: `${origin}/#reset-password/${token}`,
        });
      } catch {
        console.error("Password recovery delivery failed");
      } finally {
        deliveries--;
      }
    }),
  );
  app.post(
    "/api/auth/password-reset/complete",
    limiter,
    wrap(async (req, res) => {
      if (!available) return res.status(503).json(unavailable());
      const data = V.z
        .object({ token: V.z.string().min(20).max(1024), password: V.password })
        .parse(req.body);
      const invalid = () =>
        res.status(400).json({
          error: "Ссылка недействительна или истекла. Запросите новое письмо.",
        });
      if (!secret) return invalid();
      const parts = data.token.split(".");
      if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
        return invalid();
      const expected = Buffer.from(digest(`password-reset:${parts[0]}`)),
        actual = Buffer.from(parts[1]);
      if (
        expected.length !== actual.length ||
        !crypto.timingSafeEqual(expected, actual)
      )
        return invalid();
      let payload;
      try {
        payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      } catch {
        return invalid();
      }
      if (
        !Array.isArray(payload) ||
        payload.length !== 4 ||
        !/^\d+$/.test(payload[0]) ||
        !Number.isSafeInteger(payload[1]) ||
        !Number.isSafeInteger(payload[2]) ||
        payload[2] <= Date.now() ||
        payload[2] > Date.now() + 10 * 60000
      )
        return invalid();
      const hash = await hashPassword(data.password);
      const changed = await db.transaction(async (tx) => {
        // Recheck the demo exclusion at redemption too: an older recovery link
        // must not reset an account after it was added to the test allowlist.
        const result = await tx.query(
          "UPDATE users SET password_hash=$1,auth_version=auth_version+1,email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$2 AND auth_version=$3 AND status<>'closed' AND clock_timestamp()<$4::timestamptz AND NOT (LOWER(email)=ANY($5::text[])) RETURNING id",
          [
            hash,
            payload[0],
            payload[1],
            new Date(payload[2]).toISOString(),
            emailDemoAccounts(),
          ],
        );
        if (!result.rows[0]) return false;
        await audit(
          tx,
          result.rows[0].id,
          "password_recovered",
          "user",
          result.rows[0].id,
        );
        return true;
      });
      if (!changed) return invalid();
      await new Promise((resolve, reject) =>
        req.session.regenerate((error) => (error ? reject(error) : resolve())),
      );
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      await new Promise((resolve, reject) =>
        req.session.save((error) => (error ? reject(error) : resolve())),
      );
      res.json({ success: true, csrfToken: req.session.csrfToken });
    }),
  );
}
module.exports = { registerPasswordRecoveryRoutes, passwordRecoveryAvailable };
