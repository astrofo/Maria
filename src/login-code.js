const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");
const V = require("./validation");
const {
  VERIFICATION_CODE_LENGTH,
  createVerificationCode,
  isVerificationCode,
  emailCodeMode,
  isDemoEmailCodeMode,
  isDemoLoginEmail,
  emailCodePolicy,
  DEMO_VERIFICATION_CODE,
} = require("./verification-code");
const { z } = V;

const EXPIRES_SECONDS = 600;
const RESEND_SECONDS = 30;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const SEND_LIMIT = 5;
const FAILED_HOUR_LIMIT = 5;
const FAILED_DAY_LIMIT = 10;
const errorResult = (status, error, code, retryAfter) => ({
  status,
  body: { error, code, ...(retryAfter ? { retry_after: retryAfter } : {}) },
});
const invalidCode = () =>
  errorResult(
    400,
    "Код недействителен или истёк. Используйте код последнего запроса в том же браузере. Также можно войти по паролю.",
    "invalid_login_code",
  );
const rateLimited = (seconds) =>
  errorResult(
    429,
    "Слишком много запросов или неверных кодов. Повторите позже либо войдите по паролю.",
    "login_code_rate_limited",
    Math.max(1, Math.ceil(seconds)),
  );
const sendResult = (res, result) => {
  if (result.body.retry_after)
    res.set("Retry-After", String(result.body.retry_after));
  return res.status(result.status).json(result.body);
};
const equalHash = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  Buffer.byteLength(left) === Buffer.byteLength(right) &&
  crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));

function loginCrypto() {
  const codePolicy = emailCodePolicy();
  const secret = process.env.SESSION_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
    throw new Error("Login codes require a configured session secret");
  const hmac = (...parts) =>
    crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(parts))
      .digest("hex");
  const encryptionKey = crypto
    .createHmac("sha256", secret)
    .update("deti-marii/login-delivery-encryption/v1")
    .digest();
  const aad = (record) =>
    Buffer.from(
      JSON.stringify([
        "login-delivery/v1",
        record.email_hash,
        record.code_nonce,
        String(record.user_id ?? ""),
        String(record.auth_version ?? ""),
        record.login_session_hash,
      ]),
    );
  return {
    emailHash: (email) => hmac("login-email", email),
    sessionHash: (req) => hmac("login-session", req.sessionID),
    codeHash: (emailHash, nonce, code) =>
      hmac("login-code/v2", codePolicy, emailHash, nonce, code),
    encrypt(code, record) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(aad(record));
      const ciphertext = Buffer.concat([
        cipher.update(code, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
        "base64",
      );
    },
    decrypt(record) {
      const buffer = Buffer.from(record.code_ciphertext || "", "base64");
      if (buffer.length !== 12 + 16 + VERIFICATION_CODE_LENGTH)
        throw new Error("Invalid login delivery secret");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        buffer.subarray(0, 12),
      );
      decipher.setAAD(aad(record));
      decipher.setAuthTag(buffer.subarray(12, 28));
      const code = Buffer.concat([
        decipher.update(buffer.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      if (!isVerificationCode(code))
        throw new Error("Invalid login delivery secret");
      return code;
    },
  };
}

function budgets(record) {
  const now = new Date(record.server_now).getTime();
  const hourAge = now - new Date(record.rate_window_started_at).getTime();
  const dayAge = now - new Date(record.day_window_started_at).getTime();
  return {
    now,
    hourStart:
      hourAge >= HOUR_MS ? record.server_now : record.rate_window_started_at,
    dayStart:
      dayAge >= DAY_MS ? record.server_now : record.day_window_started_at,
    sends: hourAge >= HOUR_MS ? 0 : record.send_count,
    failures: hourAge >= HOUR_MS ? 0 : record.failed_attempts,
    dayFailures: dayAge >= DAY_MS ? 0 : record.day_failed_attempts,
    hourWait: Math.max(1, Math.ceil((HOUR_MS - hourAge) / 1000)),
    dayWait: Math.max(1, Math.ceil((DAY_MS - dayAge) / 1000)),
  };
}

function registerLoginCodeRoutes(
  app,
  { db, mailer, loginSession, publicProfile, wrap, audit },
) {
  const codeMode = emailCodeMode();
  const codec = loginCrypto();
  const availability = (req, res, next) => {
    if (req.user)
      return sendResult(
        res,
        errorResult(409, "Вы уже вошли в аккаунт", "already_authenticated"),
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
            ((req.rateLimit.resetTime?.getTime() || Date.now() + windowMs) -
              Date.now()) /
              1000,
          ),
        ),
    });

  app.post(
    "/api/auth/login-code/request",
    availability,
    limiter(HOUR_MS, 20),
    wrap(async (req, res) => {
      const { email } = z.object({ email: V.email }).parse(req.body);
      const demoCode = isDemoLoginEmail(email);
      const emailHash = codec.emailHash(email);
      const owner = codec.sessionHash(req);
      const outcome = await db.transaction(async (tx) => {
        // Delivery and verification use the same user → challenge lock order.
        // Keeping the user locked prevents closure/password reset during issue.
        const users = await tx.query(
          "SELECT id,auth_version,status FROM users WHERE email=$1 FOR SHARE",
          [email],
        );
        const user = users.rows[0];
        if (!user)
          return errorResult(
            404,
            "Аккаунт с этой почтой не найден. Зарегистрируйтесь или завершите подтверждение почты.",
            "account_not_found",
          );
        if (user.status === "closed")
          return errorResult(
            403,
            "Вход в этот аккаунт недоступен. Обратитесь к администратору.",
            "account_unavailable",
          );
        if (
          !demoCode &&
          (!mailer.available || typeof mailer.sendLoginCode !== "function")
        )
          return errorResult(
            503,
            "Вход по почте пока недоступен. Войдите по паролю.",
            "login_code_unavailable",
          );
        await tx.query(
          `INSERT INTO pending_login_codes(email_hash,login_session_hash) VALUES($1,$2)
         ON CONFLICT(email_hash) DO NOTHING`,
          [emailHash, owner],
        );
        const { rows } = await tx.query(
          "SELECT *,NOW() AS server_now FROM pending_login_codes WHERE email_hash=$1 FOR UPDATE",
          [emailHash],
        );
        const pending = rows[0],
          budget = budgets(pending);
        const lastSent = pending.last_sent_at
          ? new Date(pending.last_sent_at).getTime()
          : 0;
        if (lastSent && budget.now - lastSent < RESEND_SECONDS * 1000)
          return rateLimited(
            (RESEND_SECONDS * 1000 - budget.now + lastSent) / 1000,
          );
        if (budget.dayFailures >= FAILED_DAY_LIMIT)
          return rateLimited(budget.dayWait);
        if (budget.sends >= SEND_LIMIT || budget.failures >= FAILED_HOUR_LIMIT)
          return rateLimited(budget.hourWait);
        const record = {
          email_hash: emailHash,
          code_nonce: crypto.randomBytes(32).toString("hex"),
          user_id: user.id,
          auth_version: user.auth_version,
          login_session_hash: owner,
        };
        const code = demoCode
          ? DEMO_VERIFICATION_CODE
          : createVerificationCode({ EMAIL_CODE_MODE: "random" });
        await tx.query(
          `UPDATE pending_login_codes SET user_id=$2,auth_version=$3,login_session_hash=$4,
          code_hash=$5,code_nonce=$6,code_ciphertext=$7,expires_at=NOW()+INTERVAL '10 minutes',
          send_status=$8,delivery_claim=NULL,delivery_started_at=NULL,last_sent_at=NOW(),
          rate_window_started_at=$9,send_count=$10,failed_attempts=$11,
          day_window_started_at=$12,day_failed_attempts=$13,updated_at=NOW() WHERE email_hash=$1`,
          [
            emailHash,
            record.user_id,
            record.auth_version,
            owner,
            codec.codeHash(emailHash, record.code_nonce, code),
            record.code_nonce,
            demoCode ? null : codec.encrypt(code, record),
            demoCode ? "sent" : "queued",
            budget.hourStart,
            budget.sends + 1,
            budget.failures,
            budget.dayStart,
            budget.dayFailures,
          ],
        );
        return null;
      });
      if (outcome) return sendResult(res, outcome);
      // SMTP is performed by the durable dispatcher, never on this request path.
      return res.status(202).json({
        verification_required: true,
        email,
        code_length: VERIFICATION_CODE_LENGTH,
        expires_in: EXPIRES_SECONDS,
        resend_after: RESEND_SECONDS,
        email_code_mode: codeMode,
        delivery: demoCode ? "demo" : "email",
        ...(demoCode ? { demo_code: DEMO_VERIFICATION_CODE } : {}),
      });
    }),
  );

  app.post(
    "/api/auth/login-code/verify",
    availability,
    limiter(15 * 60000, 60),
    wrap(async (req, res) => {
      const { email, code } = z
        .object({ email: V.email, code: z.string().trim().max(64) })
        .parse(req.body);
      if (!isVerificationCode(code)) return sendResult(res, invalidCode());
      const demoCode = isDemoLoginEmail(email);
      const emailHash = codec.emailHash(email);
      const outcome = await db.transaction(async (tx) => {
        const peek = await tx.query(
          "SELECT user_id FROM pending_login_codes WHERE email_hash=$1",
          [emailHash],
        );
        const userId = peek.rows[0]?.user_id;
        const users =
          userId == null
            ? { rows: [] }
            : await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
                userId,
              ]);
        const user = users.rows[0];
        const { rows } = await tx.query(
          "SELECT *,NOW() AS server_now FROM pending_login_codes WHERE email_hash=$1 FOR UPDATE",
          [emailHash],
        );
        const pending = rows[0];
        if (
          !pending ||
          !equalHash(pending.login_session_hash, codec.sessionHash(req))
        )
          return invalidCode();
        const budget = budgets(pending);
        if (
          budget.failures >= FAILED_HOUR_LIMIT ||
          budget.dayFailures >= FAILED_DAY_LIMIT
        )
          return invalidCode();
        const valid =
          user &&
          String(user.id) === String(pending.user_id) &&
          user.email === email &&
          user.status !== "closed" &&
          user.auth_version === pending.auth_version &&
          pending.send_status === "sent" &&
          pending.code_nonce &&
          pending.code_hash &&
          new Date(pending.expires_at).getTime() > budget.now &&
          equalHash(
            pending.code_hash,
            codec.codeHash(emailHash, pending.code_nonce, code),
          );
        if (!valid) {
          // Include unknown accounts and failed deliveries so their later rate-limit
          // responses cannot disclose whether an account exists. Resends retain this.
          await tx.query(
            `UPDATE pending_login_codes SET rate_window_started_at=$2,send_count=$3,failed_attempts=$4,
             day_window_started_at=$5,day_failed_attempts=$6,
             code_hash=CASE WHEN $4>=5 OR $6>=10 THEN NULL ELSE code_hash END,
             code_ciphertext=CASE WHEN $4>=5 OR $6>=10 THEN NULL ELSE code_ciphertext END,
             send_status=CASE WHEN $4>=5 OR $6>=10 THEN 'failed' ELSE send_status END,
             updated_at=NOW() WHERE email_hash=$1`,
            [
              emailHash,
              budget.hourStart,
              budget.sends,
              budget.failures + 1,
              budget.dayStart,
              budget.dayFailures + 1,
            ],
          );
          return invalidCode();
        }
        // Consume under the challenge lock before creating a browser session:
        // two concurrent submissions cannot both redeem the same code.
        await tx.query(
          `UPDATE pending_login_codes SET send_status='consumed',code_hash=NULL,code_nonce=NULL,
          code_ciphertext=NULL,delivery_claim=NULL,delivery_started_at=NULL,updated_at=NOW() WHERE email_hash=$1`,
          [emailHash],
        );
        if (!demoCode && !user.email_verified_at) {
          const verified = await tx.query(
            "UPDATE users SET email_verified_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING email_verified_at",
            [user.id],
          );
          user.email_verified_at = verified.rows[0].email_verified_at;
        }
        await audit(
          tx,
          user.id,
          demoCode ? "login_demo_code" : "login_email_code",
          "user",
          user.id,
        );
        return { user };
      });
      if (outcome.status) return sendResult(res, outcome);
      await loginSession(req, outcome.user);
      return res.json({
        user: publicProfile(outcome.user),
        csrfToken: req.session.csrfToken,
      });
    }),
  );
}

async function cleanupLoginCodes(db) {
  // Switching to demo mode retires pending real deliveries. A later SMTP
  // configuration must not send codes requested before the switch.
  if (isDemoEmailCodeMode()) {
    await db.query(
      `UPDATE pending_login_codes SET code_ciphertext=NULL,code_hash=NULL,
        send_status='failed',delivery_claim=NULL,delivery_started_at=NULL,updated_at=NOW()
       WHERE send_status IN ('queued','sending')`,
    );
  }
  await db.query(
    `UPDATE pending_login_codes SET code_ciphertext=NULL,code_hash=NULL,
      send_status=CASE WHEN send_status='consumed' THEN send_status ELSE 'failed' END,
      delivery_claim=NULL,delivery_started_at=NULL,updated_at=NOW()
     WHERE (expires_at<=NOW() OR (send_status='sending' AND delivery_started_at<NOW()-INTERVAL '2 minutes'))
       AND (code_ciphertext IS NOT NULL OR code_hash IS NOT NULL OR delivery_claim IS NOT NULL)`,
  );
  await db.query(
    "DELETE FROM pending_login_codes WHERE updated_at<NOW()-INTERVAL '24 hours'",
  );
}

async function claimDelivery(db, codec) {
  return db.transaction(async (tx) => {
    await tx.exec(
      "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'",
    );
    const lock = await tx.query(
      "SELECT pg_try_advisory_xact_lock(1145918281,11) AS acquired",
    );
    if (!lock.rows[0]?.acquired) return null;
    const candidates = await tx.query(
      `SELECT email_hash,user_id,code_nonce FROM pending_login_codes
       WHERE send_status='queued' AND expires_at>NOW() ORDER BY last_sent_at,email_hash LIMIT 1`,
    );
    const candidate = candidates.rows[0];
    if (!candidate) return null;
    const users = await tx.query(
      "SELECT id,email,status,auth_version FROM users WHERE id=$1 FOR SHARE",
      [candidate.user_id],
    );
    const user = users.rows[0];
    const selected = await tx.query(
      "SELECT *,NOW() AS server_now FROM pending_login_codes WHERE email_hash=$1 FOR UPDATE SKIP LOCKED",
      [candidate.email_hash],
    );
    const row = selected.rows[0];
    if (
      !row ||
      row.send_status !== "queued" ||
      row.code_nonce !== candidate.code_nonce
    )
      return null;
    const eligible =
      user &&
      !isDemoLoginEmail(user.email) &&
      String(user.id) === String(row.user_id) &&
      user.status !== "closed" &&
      user.auth_version === row.auth_version &&
      equalHash(codec.emailHash(user.email), row.email_hash) &&
      row.code_ciphertext &&
      row.code_hash &&
      row.failed_attempts < FAILED_HOUR_LIMIT &&
      row.day_failed_attempts < FAILED_DAY_LIMIT &&
      new Date(row.expires_at) > new Date(row.server_now);
    if (!eligible) {
      await tx.query(
        "UPDATE pending_login_codes SET send_status='failed',code_hash=NULL,code_ciphertext=NULL,updated_at=NOW() WHERE email_hash=$1",
        [row.email_hash],
      );
      return null;
    }
    const claim = crypto.randomBytes(24).toString("hex");
    await tx.query(
      "UPDATE pending_login_codes SET send_status='sending',delivery_claim=$2,delivery_started_at=NOW(),updated_at=NOW() WHERE email_hash=$1",
      [row.email_hash, claim],
    );
    return { row, email: user.email, claim };
  });
}

function startLoginCodeDelivery({ db, mailer, intervalMs = 1000 }) {
  const codec = loginCrypto();
  let stopped = false,
    active = null,
    cleanupAt = 0;
  const deliver = async () => {
    if (Date.now() >= cleanupAt) {
      await cleanupLoginCodes(db);
      cleanupAt = Date.now() + 60000;
    }
    if (
      isDemoEmailCodeMode() ||
      !mailer.available ||
      typeof mailer.sendLoginCode !== "function"
    )
      return;
    const job = await claimDelivery(db, codec);
    if (!job) return;
    let sent = false;
    try {
      const code = codec.decrypt(job.row);
      if (
        !equalHash(
          job.row.code_hash,
          codec.codeHash(job.row.email_hash, job.row.code_nonce, code),
        )
      )
        throw new Error("Invalid login delivery secret");
      await mailer.sendLoginCode({ email: job.email, code });
      sent = true;
    } catch {
      // No SMTP messages, addresses, codes or credentials are logged or returned.
    }
    await db.query(
      `UPDATE pending_login_codes SET send_status=CASE WHEN $4 AND expires_at>NOW() THEN 'sent' ELSE 'failed' END,
        code_hash=CASE WHEN $4 AND expires_at>NOW() THEN code_hash ELSE NULL END,
        code_ciphertext=NULL,delivery_claim=NULL,delivery_started_at=NULL,updated_at=NOW()
       WHERE email_hash=$1 AND code_nonce=$2 AND delivery_claim=$3 AND send_status='sending'`,
      [job.row.email_hash, job.row.code_nonce, job.claim, sent],
    );
  };
  const tick = () => {
    if (stopped || active) return;
    active = deliver()
      .catch(() => {
        console.error("Login code dispatcher failed; will retry");
      })
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (active) await active;
  };
}

module.exports = { registerLoginCodeRoutes, startLoginCodeDelivery };
