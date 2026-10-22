const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { createAssistantModel } = require("./assistant-model");
const { isDemoEmailAccount } = require("./verification-code");
const {
  roleOf,
  allowedRoutes,
  answerFromCards,
  genericGuide,
  analyzeQuestion,
  examplesFor,
} = require("./assistant-knowledge");

const message = z.string().trim().min(1).max(1000);
const requestSchema = z
  .object({
    message,
    history: z
      .array(
        z
          .object({ role: z.enum(["user", "assistant"]), content: message })
          .strict(),
      )
      .max(6)
      .default([]),
    current_route: z.string().max(120).optional(),
  })
  .strict();

function registerAssistantRoutes(
  app,
  {
    db,
    wrap,
    registrationEnabled,
    mailAvailable,
    verificationAvailable = mailAvailable,
  },
) {
  const enabled = process.env.ASSISTANT_ENABLED !== "false";
  const model = createAssistantModel();
  const contextFor = (req) => ({
    role: roleOf(req.user),
    registrationAvailable: Boolean(
      registrationEnabled && verificationAvailable,
    ),
    mailAvailable: Boolean(mailAvailable),
    demoCode: Boolean(req.user && isDemoEmailAccount(req.user.email)),
  });
  const rateHandler = (req, res) => {
    const retry = Math.max(
      1,
      Math.ceil(
        ((req.rateLimit?.resetTime?.getTime() || Date.now() + 300000) -
          Date.now()) /
          1000,
      ),
    );
    res
      .status(429)
      .set("Retry-After", String(retry))
      .json({
        ...genericGuide(
          contextFor(req),
          "Сейчас слишком много вопросов. Можно открыть нужный раздел по кнопке ниже и вернуться к Кистику немного позже.",
        ),
        error: "Слишком много вопросов. Попробуйте позже.",
        code: "ASSISTANT_RATE_LIMIT",
        retry_after: retry,
      });
  };
  const ipLimit = rateLimit({
    windowMs: 5 * 60000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateHandler,
  });
  const sessionLimit = rateLimit({
    windowMs: 5 * 60000,
    limit: 20,
    keyGenerator: (req) => req.sessionID,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateHandler,
  });

  app.get("/api/assistant/config", (req, res) => {
    const context = contextFor(req);
    res.json({
      enabled,
      model_configured: enabled && model.configured,
      mode: enabled && model.configured ? "model" : "guide",
      examples: examplesFor(context.role),
      max_message_length: 1000,
      max_history: 6,
      // Fixed hashes only; no user identifiers, arbitrary paths or model URLs.
      allowed_hrefs: allowedRoutes(context).map((route) => route.href),
    });
  });

  // Mounted after the application's session, current-user and CSRF checks.
  // Guests obtain the same /api/auth/csrf token before this POST as members do.
  app.post(
    "/api/assistant/chat",
    ipLimit,
    sessionLimit,
    wrap(async (req, res) => {
      const input = requestSchema.parse(req.body);
      const context = contextFor(req);
      if (!enabled) {
        return res.status(503).json({
          ...genericGuide(
            context,
            "Кистик сейчас выключен. Основные разделы сайта доступны по ссылкам ниже.",
          ),
          error: "Помощник временно выключен.",
          code: "ASSISTANT_DISABLED",
        });
      }
      const result = analyzeQuestion(input, context);
      if (result.response) return res.json(result.response);
      if (!model.configured) return res.json(result.guide);

      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", disconnect);
      res.once("close", disconnect);
      try {
        const ids = await model.select(
          {
            message: input.message,
            candidates: result.candidates,
            catalog: result.catalog,
            previous: result.previous,
            currentRoute: result.currentRoute,
          },
          controller.signal,
        );
        if (controller.signal.aborted || res.destroyed) return;

        // An administrator may close an account or revoke its role while a
        // request waits for inference. Never return stale privileged actions.
        if (req.user) {
          const { rows } = await db.query(
            "SELECT role,status,auth_version FROM users WHERE id=$1",
            [req.user.id],
          );
          const current = rows[0];
          if (
            !current ||
            current.status === "closed" ||
            current.auth_version !== req.session.authVersion ||
            current.role !== req.user.role
          ) {
            return res.status(401).json({
              error:
                "Сессия или права доступа изменились. Обновите страницу и войдите снова.",
              code: "SESSION_CHANGED",
            });
          }
        }
        if (controller.signal.aborted || res.destroyed) return;
        const cards = ids
          ?.map((id) => result.candidates.find((card) => card.id === id))
          .filter(Boolean);
        res.json(
          cards?.length
            ? answerFromCards(cards, context, "model")
            : result.guide,
        );
      } finally {
        req.removeListener("aborted", disconnect);
        res.removeListener("close", disconnect);
      }
    }),
  );
}

module.exports = { registerAssistantRoutes };
