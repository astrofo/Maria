const V = require("./validation");

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const same = (a, b) => String(a) === String(b);
const catalogueFields = "id,slug,title,description,rarity,icon,sort_order";
const awardFields = `ua.id,ua.achievement_id,a.slug,a.title,a.description,a.rarity,a.icon,ua.awarded_at`;
const awardsFrom =
  "FROM user_achievements ua JOIN achievements a ON a.id=ua.achievement_id";
const awardBody = V.z.object({ achievement_id: V.id }).strict();

async function readTarget(tx, userId) {
  const { rows } = await tx.query(
    "SELECT id,role,status FROM users WHERE id=$1 FOR SHARE",
    [userId],
  );
  if (!rows[0]) fail(404, "Пользователь не найден");
  return rows[0];
}

async function readAwards(tx, userId) {
  const { rows } = await tx.query(
    `SELECT ${awardFields} ${awardsFrom} WHERE ua.user_id=$1 AND ua.revoked_at IS NULL ORDER BY a.sort_order,a.id`,
    [userId],
  );
  return { items: rows, total: rows.length };
}

async function lockAwards(tx, userId) {
  // Serialize grants and revocations without upgrading shared administrator
  // locks when an old award is removed after its recipient changes roles.
  await tx.query(
    "SELECT pg_advisory_xact_lock(91093,($1::bigint % 2147483647)::int)",
    [userId],
  );
}

function registerAchievementRoutes(
  app,
  { db, auth, requireRole, wrap, lockCurrentUser, audit, notify },
) {
  app.get(
    "/api/achievements",
    auth,
    wrap(async (req, res) => {
      const items = await db.transaction(async (tx) => {
        await lockCurrentUser(tx, req.user);
        const { rows } = await tx.query(
          `SELECT ${catalogueFields} FROM achievements ORDER BY sort_order,id`,
        );
        return rows;
      });
      res.set("Cache-Control", "no-store").json({ items });
    }),
  );

  app.get(
    "/api/me/achievements",
    auth,
    wrap(async (req, res) => {
      const data = await db.transaction(async (tx) => {
        const actor = await lockCurrentUser(tx, req.user);
        return readAwards(tx, actor.id);
      });
      res.set("Cache-Control", "no-store").json(data);
    }),
  );

  app.get(
    "/api/users/:id/achievements",
    auth,
    wrap(async (req, res) => {
      const userId = V.id.parse(req.params.id);
      const data = await db.transaction(async (tx) => {
        const actor = await lockCurrentUser(tx, req.user);
        const self = same(actor.id, userId);
        if (!self && actor.role === "volunteer") fail(403, "Недостаточно прав");
        const target = await readTarget(tx, userId);
        if (
          !self &&
          actor.role === "coordinator" &&
          target.role !== "volunteer"
        )
          fail(403, "Недостаточно прав");
        return readAwards(tx, target.id);
      });
      res.set("Cache-Control", "no-store").json(data);
    }),
  );

  app.post(
    "/api/users/:id/achievements",
    requireRole("admin"),
    wrap(async (req, res) => {
      const userId = V.id.parse(req.params.id);
      const { achievement_id } = awardBody.parse(req.body);
      const result = await db.transaction(async (tx) => {
        const actor = await lockCurrentUser(tx, req.user, "admin");
        const target = await readTarget(tx, userId);
        if (target.role !== "volunteer")
          fail(409, "Достижения выдаются только волонтёрам");
        if (target.status === "closed") fail(409, "Аккаунт волонтёра закрыт");
        await lockAwards(tx, target.id);
        const achievement = await tx.query(
          "SELECT id,title FROM achievements WHERE id=$1 FOR SHARE",
          [achievement_id],
        );
        if (!achievement.rows[0]) fail(404, "Достижение не найдено");
        const inserted = await tx.query(
          `INSERT INTO user_achievements(user_id,achievement_id,awarded_by)
           VALUES($1,$2,$3) ON CONFLICT(user_id,achievement_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
          [target.id, achievement_id, actor.id],
        );
        const { rows } = await tx.query(
          `SELECT ${awardFields} ${awardsFrom} WHERE ua.user_id=$1 AND ua.achievement_id=$2 AND ua.revoked_at IS NULL`,
          [target.id, achievement_id],
        );
        // The award, notice and audit commit together. A retried request must
        // never produce a second congratulation or a second audit entry.
        if (inserted.rows.length) {
          await notify(
            tx,
            target.id,
            "Новое достижение",
            `Вам присвоено достижение «${achievement.rows[0].title}».`,
          );
          await audit(
            tx,
            actor.id,
            "award_achievement",
            "user_achievement",
            rows[0].id,
          );
        }
        return { item: rows[0], duplicate: !inserted.rows.length };
      });
      res
        .status(result.duplicate ? 200 : 201)
        .json(result.duplicate ? result : { item: result.item });
    }),
  );

  app.delete(
    "/api/users/:id/achievements/:achievementId",
    requireRole("admin"),
    wrap(async (req, res) => {
      const userId = V.id.parse(req.params.id);
      const achievementId = V.id.parse(req.params.achievementId);
      await db.transaction(async (tx) => {
        const actor = await lockCurrentUser(tx, req.user, "admin");
        const target = await readTarget(tx, userId);
        await lockAwards(tx, target.id);
        // Keep revoked rows so audit entries still identify the award. Revocation
        // remains possible after closing or promoting a recipient.
        const removed = await tx.query(
          "UPDATE user_achievements SET revoked_at=CLOCK_TIMESTAMP(),revoked_by=$3 WHERE user_id=$1 AND achievement_id=$2 AND revoked_at IS NULL RETURNING id",
          [target.id, achievementId, actor.id],
        );
        if (removed.rows[0])
          await audit(
            tx,
            actor.id,
            "revoke_achievement",
            "user_achievement",
            removed.rows[0].id,
          );
      });
      res.status(204).end();
    }),
  );
}

module.exports = { registerAchievementRoutes };
