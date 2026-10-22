const { hashPassword } = require("./passwords");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const V = require("./validation");
const {
  VERIFICATION_CODE_LENGTH,
  createVerificationCode,
  isVerificationCode,
  emailCodePolicy,
  isDemoEmailAccount,
} = require("./verification-code");
const { z } = V;

const EXPIRES_SECONDS = 600;
const RESEND_SECONDS = 30;
const EMAIL_WINDOW_MS = 3600000;
const EMAIL_SEND_LIMIT = 5;
const errorResult = (status, error, code, retryAfter) => ({
  status,
  body: { error, code, ...(retryAfter ? { retry_after: retryAfter } : {}) },
});
const invalidCode = () =>
  errorResult(
    400,
    "Код недействителен или истёк. Запросите новый код в том же браузере, где начали регистрацию.",
    "invalid_verification_code",
  );
const rateLimited = (seconds) =>
  errorResult(
    429,
    "Слишком много запросов кода. Повторите позже.",
    "verification_rate_limited",
    Math.max(1, seconds),
  );
const sendResult = (res, result) => {
  if (result.body.retry_after)
    res.set("Retry-After", String(result.body.retry_after));
  return res.status(result.status).json(result.body);
};

function registerEmailVerificationRoutes(
  app,
  { db, mailer, registrationEnabled, loginSession, publicProfile, wrap, audit },
) {
  const codePolicy = emailCodePolicy();
  const secret = process.env.SESSION_SECRET;
  const hmac = (...parts) =>
    crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(parts))
      .digest("hex");
  const sessionHash = (req) => hmac("registration-session", req.sessionID);
  const codeHash = (email, nonce, code) =>
    hmac("registration-code/v2", codePolicy, email, nonce, code);
  const equalHash = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const availability = (req, res, next) => {
    if (!registrationEnabled)
      return sendResult(
        res,
        errorResult(403, "Регистрация временно закрыта", "registration_closed"),
      );
    if (req.user)
      return sendResult(
        res,
        errorResult(409, "Вы уже вошли в аккаунт", "already_authenticated"),
      );
    next();
  };
  const mailAvailability = (_req, res, next) => {
    if (!mailer.available || typeof mailer.sendVerification !== "function")
      return sendResult(
        res,
        errorResult(
          503,
          "Отправка писем пока не настроена. Регистрация временно недоступна.",
          "email_verification_unavailable",
        ),
      );
    next();
  };
  const limiter = (windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) =>
        sendResult(
          res,
          rateLimited(
            Math.ceil(
              ((req.rateLimit.resetTime?.getTime() || Date.now() + windowMs) -
                Date.now()) /
                1000,
            ),
          ),
        ),
    });
  const sendLimiter = limiter(EMAIL_WINDOW_MS, 20);
  const verifyLimiter = limiter(15 * 60000, 60);
  const registration = z.object({
    full_name: V.text(120).min(2),
    email: V.email,
    password: V.password,
    city: V.text(120).optional(),
    phone: V.text(40).optional(),
    birth_date: V.birthday.nullable().optional(),
    gender: z.enum(["female", "male", "unspecified"]).default("unspecified"),
    rules_accepted: z.literal(true),
    privacy_accepted: z.literal(true),
  });

  // Reserve the next code under a row lock; SMTP runs outside the transaction.
  // A nonce guards against an older SMTP response overwriting a newer request.
  async function reserveCode(req, email, signup) {
    const code = createVerificationCode({ EMAIL_CODE_MODE: "random" });
    const nonce = crypto.randomBytes(32).toString("hex");
    const owner = sessionHash(req);
    return db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM pending_email_registrations WHERE updated_at < NOW() - INTERVAL '24 hours'",
      );
      if (isDemoEmailAccount(email))
        return errorResult(
          409,
          "Этот адрес используется для тестового входа. Для регистрации укажите свою почту.",
          "registration_unavailable",
        );
      if (signup) {
        const existing = await tx.query("SELECT id FROM users WHERE email=$1", [
          email,
        ]);
        if (existing.rows.length)
          return errorResult(
            409,
            "Не удалось начать регистрацию. Если у вас уже есть аккаунт, войдите в него.",
            "registration_unavailable",
          );
        await tx.query(
          `INSERT INTO pending_email_registrations
            (email,profile,password_hash,registration_session_hash,consent_version,consent_accepted_at)
           VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(email) DO NOTHING`,
          [
            email,
            JSON.stringify(signup.profile),
            signup.passwordHash,
            owner,
            process.env.CONSENT_VERSION || "1",
          ],
        );
      }
      const { rows } = await tx.query(
        "SELECT *, NOW() AS server_now FROM pending_email_registrations WHERE email=$1 FOR UPDATE",
        [email],
      );
      const pending = rows[0];
      if (
        !pending ||
        (!signup && !equalHash(pending.registration_session_hash, owner))
      )
        return invalidCode();
      const now = new Date(pending.server_now).getTime();
      const lastSent = pending.last_sent_at
        ? new Date(pending.last_sent_at).getTime()
        : 0;
      if (lastSent && now - lastSent < RESEND_SECONDS * 1000)
        return rateLimited(
          Math.ceil((RESEND_SECONDS * 1000 - now + lastSent) / 1000),
        );
      const windowAge =
        now - new Date(pending.rate_window_started_at).getTime();
      if (windowAge < EMAIL_WINDOW_MS && pending.send_count >= EMAIL_SEND_LIMIT)
        return rateLimited(Math.ceil((EMAIL_WINDOW_MS - windowAge) / 1000));
      const windowStart =
        windowAge >= EMAIL_WINDOW_MS
          ? pending.server_now
          : pending.rate_window_started_at;
      const count = windowAge >= EMAIL_WINDOW_MS ? 1 : pending.send_count + 1;
      await tx.query(
        `UPDATE pending_email_registrations SET profile=$2,password_hash=$3,
          registration_session_hash=$4,consent_version=$5,consent_accepted_at=$6,
          code_hash=$7,code_nonce=$8,expires_at=NOW() + INTERVAL '10 minutes',
          failed_attempts=0,send_status='sending',last_sent_at=NOW(),
          rate_window_started_at=$9,send_count=$10,updated_at=NOW() WHERE email=$1`,
        [
          email,
          JSON.stringify(signup?.profile || pending.profile),
          signup?.passwordHash || pending.password_hash,
          owner,
          signup ? process.env.CONSENT_VERSION || "1" : pending.consent_version,
          signup ? pending.server_now : pending.consent_accepted_at,
          codeHash(email, nonce, code),
          nonce,
          windowStart,
          count,
        ],
      );
      return { code, nonce };
    });
  }

  async function deliverCode(req, res, email, signup) {
    const reservation = await reserveCode(req, email, signup);
    if (reservation.status) return sendResult(res, reservation);
    try {
      await mailer.sendVerification({ email, code: reservation.code });
    } catch {
      // Never return SMTP diagnostics, message content or credentials to callers.
      await db.query(
        "UPDATE pending_email_registrations SET send_status='failed',code_hash=NULL,updated_at=NOW() WHERE email=$1 AND code_nonce=$2",
        [email, reservation.nonce],
      );
      return sendResult(
        res,
        errorResult(
          503,
          "Не удалось отправить письмо. Проверьте адрес и повторите запрос через минуту.",
          "email_delivery_failed",
          RESEND_SECONDS,
        ),
      );
    }
    const sent = await db.query(
      `UPDATE pending_email_registrations SET send_status='sent',expires_at=NOW() + INTERVAL '10 minutes',
       updated_at=NOW() WHERE email=$1 AND code_nonce=$2 RETURNING email`,
      [email, reservation.nonce],
    );
    if (!sent.rows.length) return sendResult(res, invalidCode());
    res.status(202).json({
      verification_required: true,
      email,
      code_length: VERIFICATION_CODE_LENGTH,
      expires_in: EXPIRES_SECONDS,
      resend_after: RESEND_SECONDS,
      email_code_mode: "random",
      delivery: "email",
    });
  }

  app.post(
    "/api/auth/register",
    availability,
    mailAvailability,
    sendLimiter,
    wrap(async (req, res) => {
      const data = registration.parse(req.body);
      const passwordHash = await hashPassword(data.password);
      const profile = {
        full_name: data.full_name,
        city: data.city || null,
        phone: data.phone || null,
        birth_date: data.birth_date || null,
        gender: data.gender,
      };
      return deliverCode(req, res, data.email, { profile, passwordHash });
    }),
  );

  app.post(
    "/api/auth/resend-code",
    availability,
    mailAvailability,
    sendLimiter,
    wrap(async (req, res) => {
      const { email } = z.object({ email: V.email }).parse(req.body);
      return deliverCode(req, res, email);
    }),
  );

  app.post(
    "/api/auth/verify-email",
    availability,
    verifyLimiter,
    wrap(async (req, res) => {
      const { email, code } = z
        .object({
          email: V.email,
          code: z.string().trim().max(64),
        })
        .parse(req.body);
      if (!isVerificationCode(code) || isDemoEmailAccount(email))
        return sendResult(res, invalidCode());
      const outcome = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          "SELECT *, NOW() AS server_now FROM pending_email_registrations WHERE email=$1 FOR UPDATE",
          [email],
        );
        const pending = rows[0];
        if (
          !pending ||
          !equalHash(pending.registration_session_hash, sessionHash(req)) ||
          pending.send_status !== "sent" ||
          !pending.code_hash ||
          pending.failed_attempts >= 5 ||
          new Date(pending.expires_at) <= new Date(pending.server_now)
        )
          return invalidCode();
        if (
          !equalHash(
            pending.code_hash,
            codeHash(email, pending.code_nonce, code),
          )
        ) {
          // Return an error value so the failed-attempt update is committed.
          await tx.query(
            `UPDATE pending_email_registrations SET failed_attempts=failed_attempts+1,
           code_hash=CASE WHEN failed_attempts >= 4 THEN NULL ELSE code_hash END,
           updated_at=NOW() WHERE email=$1`,
            [email],
          );
          return invalidCode();
        }
        const data = pending.profile;
        const created = await tx.query(
          `INSERT INTO users(full_name,email,password_hash,city,birth_date,gender,
          rules_accepted_at,privacy_accepted_at,consent_version,email_verified_at,phone)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,NOW(),$9)
         ON CONFLICT(email) DO NOTHING RETURNING *`,
          [
            data.full_name,
            email,
            pending.password_hash,
            data.city,
            data.birth_date,
            data.gender,
            pending.consent_accepted_at,
            pending.consent_version,
            data.phone || null,
          ],
        );
        await tx.query(
          "DELETE FROM pending_email_registrations WHERE email=$1",
          [email],
        );
        const user = created.rows[0];
        // A concurrent trusted account creation must never log this signup into it.
        if (!user) return invalidCode();
        await audit(tx, user.id, "register_email_verified", "user", user.id);
        return { user };
      });
      if (outcome.status) return sendResult(res, outcome);
      await loginSession(req, outcome.user);
      res.status(201).json({
        user: publicProfile(outcome.user),
        csrfToken: req.session.csrfToken,
      });
    }),
  );
}

module.exports = { registerEmailVerificationRoutes };
